        // ── Macros mini widget UI ──
        // Renders inside the #macros-panel container that renderMiniWidgetsSettings()
        // creates for the Macros registry entry. All persistence lives in the main
        // process (macros-config.json) since recording/playback/global hotkeys are
        // main-process concerns — this file is purely the management UI.

        let macrosData = null;            // last snapshot from macros-get
        let macrosExpandedId = null;      // macro whose step editor is open
        let macrosBindTarget = null;      // { kind: 'macro'|'toggle', id? } while capturing a hotkey
        let macrosKeyCapture = null;      // callback while capturing a key name for a step
        let macrosMouseCapture = null;    // callback while capturing a mouse button for a step
        let macrosCaptureTarget = null;   // { id, index } while Alt+X position capture is armed
        let macrosRecordFiltersOpen = false; // "Record new" dropdown open state

        // What a fresh recording captures. Toggled from the dropdown next to
        // "Record new" and remembered across sessions.
        const MACRO_RECORD_FILTERS = [
            ['mouseMove', 'Mouse movement'],
            ['mouseButtons', 'Mouse buttons'],
            ['keyboard', 'Keyboard keys'],
            ['delays', 'Delays (waits)']
        ];
        let macrosRecordFilters = (() => {
            const def = { mouseMove: true, mouseButtons: true, keyboard: true, delays: true };
            try {
                const raw = JSON.parse(localStorage.getItem('macroRecordFilters') || '{}');
                return { ...def, ...raw };
            } catch (e) {
                return def;
            }
        })();

        const MACRO_BUTTON_NAMES = ['Left', 'Right', 'Middle', 'Mouse 4', 'Mouse 5'];
        // DOM MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) ->
        // engine step button index (0 left, 1 right, 2 middle, 3 Mouse4, 4 Mouse5).
        const MACRO_DOM_BUTTON_TO_STEP_B = { 0: 0, 2: 1, 1: 2, 3: 3, 4: 4 };
        const MACRO_TRIGGERS = [
            ['pressed', 'Key Pressed'],
            ['hold', 'Key Hold'],
            ['toggle', 'Key Toggle'],
            ['released', 'Key Released']
        ];
        const MACRO_TRIGGER_HINTS = {
            pressed: 'Plays when the hotkey is pressed.',
            hold: 'Plays while the hotkey is physically held down — releasing it stops. The key still reaches the focused app.',
            toggle: 'Hotkey starts it, pressing the hotkey again stops it.',
            released: 'Plays when the hotkey is released. The key still reaches the focused app.'
        };
        const MACRO_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

        // Mouse buttons usable as macro triggers. DOM MouseEvent.button →
        // hotkey name (kept in sync with MOUSE_HOTKEY_VK in main/macros.js).
        const MACRO_MOUSE_BUTTONS = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'Mouse4', 4: 'Mouse5' };
        const MACRO_MOUSE_LABELS = { MouseLeft: 'Left Click', MouseRight: 'Right Click', MouseMiddle: 'Middle Click', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5' };
        let macrosSuppressContextMenu = false; // eat the menu a right-click bind would open

        function formatMacroHotkey(hk) {
            if (hk && MACRO_MOUSE_LABELS[hk]) return MACRO_MOUSE_LABELS[hk];
            return formatHotkeyDisplay(hk);
        }

        // Maps a keydown to the key names the macro engine understands (see
        // NAME_TO_VK in main/macros.js). Uses e.code so letters are layout-stable.
        function macroEventToKeyName(e) {
            const code = e.code || '';
            let m;
            if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
            if ((m = /^Digit(\d)$/.exec(code))) return m[1];
            if ((m = /^F(\d{1,2})$/.exec(code))) return `F${m[1]}`;
            if ((m = /^Numpad(\d)$/.exec(code))) return `Num${m[1]}`;
            const codeMap = {
                NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.', NumpadEnter: 'Enter',
                ShiftLeft: 'LShift', ShiftRight: 'RShift', ControlLeft: 'LCtrl', ControlRight: 'RCtrl',
                AltLeft: 'LAlt', AltRight: 'RAlt', MetaLeft: 'LWin', MetaRight: 'RWin', ContextMenu: 'Menu',
                ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
                Semicolon: ';', Equal: '=', Comma: ',', Minus: '-', Period: '.', Slash: '/',
                Backquote: '`', BracketLeft: '[', Backslash: '\\', BracketRight: ']', Quote: "'",
                Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
                CapsLock: 'CapsLock', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
                PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause', ScrollLock: 'ScrollLock',
                NumLock: 'NumLock', PrintScreen: 'PrintScreen'
            };
            if (code in codeMap) return codeMap[code];
            if (e.key && e.key.length === 1) return e.key.toUpperCase();
            return null;
        }

        // Rough per-run duration, mirroring compileStepsToEvents timing in main.
        function macroRunDuration(m) {
            let ms = 0;
            for (const s of m.steps || []) {
                if (!s || typeof s !== 'object') continue;
                if (s.t === 'delay') ms += Number(s.ms) || 0;
                else if (s.t === 'key') ms += 50;
                else if (s.t === 'kd' || s.t === 'ku' || s.t === 'md' || s.t === 'mu') ms += 10;
                else if (s.t === 'click') ms += Number.isFinite(s.x) ? 75 : 60;
                else if (s.t === 'move') ms += 15;
                else if (s.t === 'scroll') ms += 20;
                else if (s.t === 'text') ms += String(s.s || '').length * 25;
                else if (s.t === 'path') ms += (s.pts || []).reduce((a, p) => a + (Number(p[0]) || 0), 0);
            }
            return ms / (Number(m.speed) > 0 ? Number(m.speed) : 1);
        }

        async function refreshMacrosData() {
            if (!window.electronAPI?.macrosGet) return;
            try {
                macrosData = await window.electronAPI.macrosGet();
            } catch (e) {
                console.error('Failed to load macros', e);
            }
        }

        // Used by spotify-widget.js to keep type-to-search from stealing keys
        // while a recording is running.
        function isMacroRecording() {
            return !!(macrosData && macrosData.state === 'recording');
        }

        // Also used by spotify-widget.js. Both scripts attach capture-phase
        // keydown listeners to document, so this module's stopPropagation() can't
        // block spotify-widget's type-to-search (same target). This lets that
        // handler bow out while we're capturing a macro hotkey or a step key.
        function isMacroBinding() {
            return !!(macrosBindTarget || macrosKeyCapture);
        }

        async function renderMacrosPanel() {
            const panel = document.getElementById('macros-panel');
            if (!panel) return;
            // Re-rendering replaces the whole panel's innerHTML, which would otherwise
            // reset the steps list's scroll position back to the top on every edit
            // (e.g. deleting a step) -- capture it here and restore it after.
            const scrollEl = macrosExpandedId ? document.getElementById(`macro-steps-scroll-${macrosExpandedId}`) : null;
            const savedScrollTop = scrollEl ? scrollEl.scrollTop : null;
            await refreshMacrosData();
            if (!macrosData) { panel.innerHTML = ''; return; }

            const d = macrosData;
            const busy = d.state !== 'idle';
            let html = '';

            if (d.state === 'recording') {
                html += `<div class="flex items-center justify-between gap-3 mt-3 mb-3 border border-red-500/40 bg-red-500/10 rounded-xl px-3 py-2 text-xs">
                    <span class="text-red-400"><i class="fas fa-circle mr-1.5 animate-pulse"></i>Recording — press ${esc(formatHotkeyDisplay(d.toggleHotkey))} to stop</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="stopMacros()">Stop</button>
                </div>`;
            } else if (d.state === 'playing') {
                const playing = d.macros.find(m => m.id === d.activeMacroId);
                html += `<div class="flex items-center justify-between gap-3 mt-3 mb-3 border border-white/20 bg-white/5 rounded-xl px-3 py-2 text-xs">
                    <span class="text-neutral-300"><i class="fas fa-play mr-1.5"></i>Playing ${esc(playing ? playing.name : 'macro')} — press ${esc(formatHotkeyDisplay(d.toggleHotkey))} to stop</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="stopMacros()">Stop</button>
                </div>`;
            }

            html += `<div class="flex items-center justify-between gap-3 mt-3 mb-2">
                <button type="button" class="hotkey-bind no-drag" onclick="toggleMacrosArmed()" title="Enable or disable all macro triggers">
                    <i class="fas ${d.armed ? 'fa-circle-check text-emerald-400' : 'fa-circle-xmark text-neutral-500'} mr-1.5"></i>${d.armed ? 'Macros enabled' : 'Macros disabled'}
                </button>
                <div class="flex items-center gap-2 shrink-0">
                    <span class="text-xs text-neutral-500">toggle key</span>
                    <button type="button" id="macro-toggle-hotkey-btn" class="hotkey-bind no-drag" onclick="startMacroHotkeyBind('toggle')">${esc(formatHotkeyDisplay(d.toggleHotkey))}</button>
                </div>
            </div>`;

            if (!d.enabled) {
                html += `<p class="text-xs text-neutral-600 mb-2">Widget disabled — macro hotkeys are inactive. The ▶ buttons below still work for testing.</p>`;
            } else if (!d.armed) {
                html += `<p class="text-xs text-neutral-600 mb-2">Macros disabled — triggers are off. Press ${esc(formatHotkeyDisplay(d.toggleHotkey))} or click “Macros disabled” to re-enable.</p>`;
            }

            if (!d.macros.length) {
                html += `<p class="text-xs text-neutral-600 my-3">No macros yet. Record one, or build one step by step.</p>`;
            }

            for (const m of d.macros) {
                const isPlaying = d.state === 'playing' && d.activeMacroId === m.id;
                const expanded = macrosExpandedId === m.id;
                const triggerOptions = MACRO_TRIGGERS.map(([value, label]) =>
                    `<option value="${value}" ${m.trigger === value ? 'selected' : ''}>${label}</option>`).join('');
                html += `<div class="border border-white/10 rounded-xl p-3 mb-2 ${m.on ? '' : 'opacity-60'}">
                    <div class="flex items-center gap-2">
                        <input type="checkbox" ${m.on ? 'checked' : ''} onchange="setMacroOn('${m.id}', this.checked)"
                            class="accent-white shrink-0" title="Enable this macro">
                        <input type="text" value="${esc(m.name)}" onchange="renameMacro('${m.id}', this.value)"
                            class="flex-1 min-w-0 bg-transparent border border-transparent hover:border-neutral-700 focus:border-neutral-500 rounded-lg px-2 py-1 text-sm focus:outline-none">
                        <button type="button" id="macro-hotkey-btn-${m.id}" class="hotkey-bind no-drag" title="Trigger — click then press a key or mouse button, Esc while binding to clear"
                            onclick="startMacroHotkeyBind('macro', '${m.id}')">${esc(formatMacroHotkey(m.hotkey))}</button>
                        <select class="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:border-neutral-500 shrink-0"
                            title="${esc(MACRO_TRIGGER_HINTS[m.trigger] || '')}" onchange="setMacroTrigger('${m.id}', this.value)">${triggerOptions}</select>
                        ${isPlaying
                            ? `<button type="button" class="hotkey-bind no-drag" title="Stop" onclick="stopMacros()"><i class="fas fa-stop"></i></button>`
                            : `<button type="button" class="hotkey-bind no-drag" title="Play" onclick="playMacro('${m.id}')" ${busy ? 'disabled' : ''}><i class="fas fa-play"></i></button>`}
                        <button type="button" class="hotkey-bind no-drag" title="Edit steps" onclick="toggleMacroEditor('${m.id}')"><i class="fas fa-pen"></i></button>
                        <button type="button" class="hotkey-bind no-drag" title="Delete" onclick="deleteMacro('${m.id}')"><i class="fas fa-trash"></i></button>
                    </div>
                    ${expanded ? renderMacroEditor(m, busy) : ''}
                </div>`;
            }

            const filterItems = MACRO_RECORD_FILTERS.map(([key, label]) =>
                `<label class="flex items-center gap-2 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5 cursor-pointer">
                    <input type="checkbox" ${macrosRecordFilters[key] ? 'checked' : ''} onchange="setRecordFilter('${key}', this.checked)" class="accent-white">
                    ${label}
                </label>`).join('');
            html += `<div class="flex items-center justify-between gap-2 mt-2">
                <div class="flex items-center gap-2">
                    <div class="relative flex items-stretch" id="record-filters-wrap">
                        <button type="button" class="hotkey-bind no-drag rounded-r-none" onclick="recordNewMacro(null)" ${busy ? 'disabled' : ''}><i class="fas fa-circle mr-1.5 text-red-400"></i>Record new</button>
                        <button type="button" class="hotkey-bind no-drag rounded-l-none -ml-px px-2" title="Choose what to record" onclick="toggleRecordFilters(event)" ${busy ? 'disabled' : ''}><i class="fas fa-caret-down"></i></button>
                        <div id="record-filters-menu" class="${macrosRecordFiltersOpen ? '' : 'hidden'} absolute bottom-full left-0 mb-1 z-20 min-w-[180px] rounded-xl border border-white/10 bg-neutral-900/95 backdrop-blur py-1 shadow-xl">
                            <p class="px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">Record</p>
                            ${filterItems}
                        </div>
                    </div>
                    <button type="button" class="hotkey-bind no-drag" onclick="addEmptyMacro()" ${busy ? 'disabled' : ''}><i class="fas fa-plus mr-1.5"></i>Add macro</button>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" class="hotkey-bind no-drag" title="Import macros from a file" onclick="importMacros()" ${busy ? 'disabled' : ''}><i class="fas fa-file-import"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Export all macros to a file" onclick="exportMacros()" ${d.macros.length ? '' : 'disabled'}><i class="fas fa-file-export"></i></button>
                </div>
            </div>`;

            panel.innerHTML = html;
            if (savedScrollTop !== null) {
                const newScrollEl = document.getElementById(`macro-steps-scroll-${macrosExpandedId}`);
                if (newScrollEl) newScrollEl.scrollTop = savedScrollTop;
            }
        }

        function macroStepBody(m, s, i) {
            const numCls = 'bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-neutral-500 text-center';
            if (s.t === 'delay') {
                return `Wait <input type="number" min="0" max="600000" value="${Number(s.ms) || 0}"
                    onchange="setMacroDelay('${m.id}', ${i}, this.value)" class="w-20 ${numCls}"> ms`;
            }
            if (s.t === 'key') return `Press <b>${esc(s.k)}</b>`;
            if (s.t === 'kd') return `Hold <b>${esc(s.k)}</b>`;
            if (s.t === 'ku') return `Release <b>${esc(s.k)}</b>`;
            if (s.t === 'click') {
                const pos = Number.isFinite(s.x) ? ` at (${s.x}, ${s.y})` : '';
                return `${MACRO_BUTTON_NAMES[s.b] || 'Left'} click${pos}`;
            }
            if (s.t === 'md') return `${MACRO_BUTTON_NAMES[s.b] || 'Left'} button down`;
            if (s.t === 'mu') return `${MACRO_BUTTON_NAMES[s.b] || 'Left'} button up`;
            if (s.t === 'move') {
                return Number.isFinite(s.x) ? `Move mouse to (${s.x}, ${s.y})` : `Move mouse to <span class="text-neutral-600">(not set)</span>`;
            }
            if (s.t === 'scroll') {
                const d = Number(s.d) || 1;
                return `Scroll <select onchange="setMacroScroll('${m.id}', ${i}, null, this.value)"
                        class="bg-neutral-900 border border-neutral-700 rounded-lg px-1 py-0.5 text-xs focus:outline-none focus:border-neutral-500">
                        <option value="1" ${d > 0 ? 'selected' : ''}>up</option>
                        <option value="-1" ${d < 0 ? 'selected' : ''}>down</option>
                    </select> <input type="number" min="1" max="100" value="${Math.abs(d)}"
                        onchange="setMacroScroll('${m.id}', ${i}, this.value, null)" class="w-14 ${numCls}"> notch(es)`;
            }
            if (s.t === 'text') {
                return `Type <input type="text" value="${esc(s.s || '')}" placeholder="text to type…"
                    onchange="setMacroText('${m.id}', ${i}, this.value)"
                    class="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-neutral-500">`;
            }
            if (s.t === 'path') {
                const dur = (s.pts || []).reduce((a, p) => a + (Number(p[0]) || 0), 0);
                return `Mouse path · ${(s.pts || []).length} points · ${(dur / 1000).toFixed(1)}s`;
            }
            return '?';
        }

        function renderMacroEditor(m, busy) {
            let rows = '';
            (m.steps || []).forEach((s, i) => {
                const canPos = s.t === 'click' || s.t === 'move';
                const armed = macrosCaptureTarget && macrosCaptureTarget.id === m.id && macrosCaptureTarget.index === i;
                let posBtns = '';
                if (canPos) {
                    posBtns = `<button type="button" class="hotkey-bind no-drag ${armed ? 'listening' : ''}" title="Alt + X for position — hover the target and press Alt+X"
                        onclick="armMacroPointCapture('${m.id}', ${i})">${armed ? 'Alt+X…' : '<i class="fas fa-crosshairs"></i>'}</button>`;
                    if (s.t === 'click' && Number.isFinite(s.x)) {
                        posBtns += `<button type="button" class="hotkey-bind no-drag" title="Remove fixed position (click wherever the cursor is)"
                            onclick="clearMacroClickPos('${m.id}', ${i})"><i class="fas fa-eraser"></i></button>`;
                    }
                }
                rows += `<div class="flex items-center gap-2 text-xs text-neutral-400 py-1 border-b border-white/5">
                    <span class="flex-1 min-w-0 truncate flex items-center gap-1.5">${macroStepBody(m, s, i)}</span>
                    ${posBtns}
                    <button type="button" class="hotkey-bind no-drag" title="Move up" onclick="moveMacroStep('${m.id}', ${i}, -1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Move down" onclick="moveMacroStep('${m.id}', ${i}, 1)" ${i === (m.steps || []).length - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Duplicate this step" onclick="duplicateMacroStep('${m.id}', ${i})"><i class="fas fa-copy"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Remove" onclick="removeMacroStep('${m.id}', ${i})"><i class="fas fa-xmark"></i></button>
                </div>`;
            });
            if (!rows) rows = `<p class="text-xs text-neutral-600 py-1">No steps yet.</p>`;

            const forever = m.repeat === 0;
            const playbackRow = m.trigger === 'hold'
                ? `<span class="text-xs text-neutral-600"><i class="fas fa-hand mr-1"></i>Loops for as long as the key is held</span>`
                : `<span class="text-xs text-neutral-400">Repeat</span>
                    <input type="number" min="1" max="9999" value="${forever ? '' : (m.repeat || 1)}" ${forever ? 'disabled' : ''}
                        onchange="setMacroRepeat('${m.id}', this.value)"
                        class="w-16 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-neutral-500 text-center disabled:opacity-40">
                    <span class="text-xs text-neutral-400">time(s)</span>
                    <label class="flex items-center gap-1.5 cursor-pointer text-xs text-neutral-400">
                        <input type="checkbox" ${forever ? 'checked' : ''} onchange="setMacroRepeatForever('${m.id}', this.checked)" class="accent-white">
                        until stopped
                    </label>`;
            const speedOptions = MACRO_SPEEDS.map((v) =>
                `<option value="${v}" ${Number(m.speed) === v ? 'selected' : ''}>${v}×</option>`).join('');
            const dur = macroRunDuration(m);

            return `<div class="mt-3 pt-2 border-t border-white/10">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                    ${playbackRow}
                    <span class="flex-1"></span>
                    <span class="text-xs text-neutral-400">Speed</span>
                    <select onchange="setMacroSpeed('${m.id}', this.value)"
                        class="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-xs focus:outline-none focus:border-neutral-500">${speedOptions}</select>
                </div>
                <p class="text-xs text-neutral-600 mb-2">${esc(MACRO_TRIGGER_HINTS[m.trigger] || '')}${dur > 0 ? ` · ~${(dur / 1000).toFixed(1)}s per run` : ''}</p>
                <div id="macro-steps-scroll-${m.id}" class="max-h-48 overflow-y-auto pr-1">${rows}</div>
                <div class="flex items-center gap-2 mt-2">
                    <select id="macro-add-step-type-${m.id}" class="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-neutral-500">
                        <option value="key">Key press</option>
                        <option value="kd">Hold key</option>
                        <option value="ku">Release key</option>
                        <option value="click">Mouse click</option>
                        <option value="mdown">Hold mouse button</option>
                        <option value="mup">Release mouse button</option>
                        <option value="scroll-up">Scroll up</option>
                        <option value="scroll-down">Scroll down</option>
                        <option value="move">Move mouse to…</option>
                        <option value="text">Type text</option>
                        <option value="delay">Delay</option>
                    </select>
                    <button type="button" id="macro-add-step-btn-${m.id}" class="hotkey-bind no-drag" onclick="addMacroStep('${m.id}')">Add step</button>
                    <button type="button" class="hotkey-bind no-drag" title="Duplicate this macro" onclick="duplicateMacro('${m.id}')"><i class="fas fa-copy"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Clear all steps" onclick="clearMacroSteps('${m.id}')" ${(m.steps || []).length ? '' : 'disabled'}><i class="fas fa-eraser"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Re-record this macro (replaces its steps)" onclick="recordNewMacro('${m.id}')" ${busy ? 'disabled' : ''}>
                        <i class="fas fa-circle mr-1 text-red-400"></i>Re-record</button>
                </div>
            </div>`;
        }

        function getMacro(id) {
            return macrosData?.macros.find(m => m.id === id) || null;
        }

        async function saveMacro(m) {
            if (!window.electronAPI?.macrosSave) return;
            const result = await window.electronAPI.macrosSave(m);
            if (result && result.ok && result.hotkeyOk === false) {
                showToast('Hotkey unavailable or already in use', true);
            }
            scheduleSettingsSave();
            await renderMacrosPanel();
        }

        async function renameMacro(id, name) {
            const m = getMacro(id);
            if (!m) return;
            m.name = (name || '').trim() || m.name;
            await saveMacro(m);
        }

        async function setMacroOn(id, on) {
            const m = getMacro(id);
            if (!m) return;
            m.on = !!on;
            await saveMacro(m);
        }

        async function setMacroTrigger(id, trigger) {
            const m = getMacro(id);
            if (!m) return;
            // Toggle mode usually means "loop until I press the key again" — flip
            // the default 1× repeat to ∞ so it behaves as expected out of the box.
            if (trigger === 'toggle' && m.repeat === 1) m.repeat = 0;
            m.trigger = trigger;
            await saveMacro(m);
        }

        async function setMacroRepeat(id, value) {
            const m = getMacro(id);
            if (!m) return;
            m.repeat = Math.min(9999, Math.max(1, Math.round(Number(value) || 1)));
            await saveMacro(m);
        }

        async function setMacroRepeatForever(id, forever) {
            const m = getMacro(id);
            if (!m) return;
            m.repeat = forever ? 0 : 1;
            await saveMacro(m);
        }

        async function setMacroSpeed(id, value) {
            const m = getMacro(id);
            if (!m) return;
            m.speed = Number(value) || 1;
            await saveMacro(m);
        }

        async function deleteMacro(id) {
            if (!window.electronAPI?.macrosDelete) return;
            await window.electronAPI.macrosDelete(id);
            if (macrosExpandedId === id) macrosExpandedId = null;
            scheduleSettingsSave();
            showToast('Macro deleted');
            await renderMacrosPanel();
        }

        async function addEmptyMacro() {
            await saveMacro({ id: null, name: `Macro ${(macrosData?.macros.length || 0) + 1}`, hotkey: null, trigger: 'pressed', repeat: 1, speed: 1, on: true, steps: [] });
        }

        async function duplicateMacro(id) {
            const m = getMacro(id);
            if (!m) return;
            const copy = JSON.parse(JSON.stringify(m));
            copy.id = null;
            copy.name = `${m.name} copy`;
            copy.hotkey = null; // a hotkey can only belong to one macro
            await saveMacro(copy);
            showToast('Macro duplicated — give the copy its own hotkey');
        }

        async function clearMacroSteps(id) {
            const m = getMacro(id);
            if (!m || !(m.steps || []).length) return;
            m.steps = [];
            await saveMacro(m);
            showToast('Steps cleared');
        }

        function toggleMacroEditor(id) {
            macrosExpandedId = macrosExpandedId === id ? null : id;
            renderMacrosPanel();
        }

        async function playMacro(id) {
            if (!window.electronAPI?.macrosPlay) return;
            const result = await window.electronAPI.macrosPlay(id);
            if (result && !result.ok) {
                showToast(result.error === 'empty' ? 'This macro has no steps' : 'Could not start macro', true);
            }
            await renderMacrosPanel();
        }

        async function stopMacros() {
            if (!window.electronAPI?.macrosStop) return;
            await window.electronAPI.macrosStop();
        }

        async function recordNewMacro(targetId) {
            if (!window.electronAPI?.macrosRecordStart) return;
            macrosRecordFiltersOpen = false;
            showToast('Starting recorder…');
            const result = await window.electronAPI.macrosRecordStart(targetId, macrosRecordFilters);
            if (result && !result.ok) {
                showToast(result.error === 'busy' ? 'Already recording or playing' : 'Could not start recording', true);
            }
            await renderMacrosPanel();
        }

        // ── "Record new" filter dropdown ──
        function toggleRecordFilters(ev) {
            if (ev) ev.stopPropagation();
            macrosRecordFiltersOpen = !macrosRecordFiltersOpen;
            const menu = document.getElementById('record-filters-menu');
            if (menu) menu.classList.toggle('hidden', !macrosRecordFiltersOpen);
        }

        function setRecordFilter(key, value) {
            macrosRecordFilters[key] = !!value;
            try {
                localStorage.setItem('macroRecordFilters', JSON.stringify(macrosRecordFilters));
            } catch (e) { /* storage unavailable — keep the in-memory value */ }
        }

        // Close the dropdown when clicking anywhere outside it.
        document.addEventListener('click', (e) => {
            if (!macrosRecordFiltersOpen) return;
            const wrap = document.getElementById('record-filters-wrap');
            if (wrap && !wrap.contains(e.target)) {
                macrosRecordFiltersOpen = false;
                const menu = document.getElementById('record-filters-menu');
                if (menu) menu.classList.add('hidden');
            }
        });

        async function exportMacros() {
            if (!window.electronAPI?.macrosExport) return;
            const result = await window.electronAPI.macrosExport();
            if (result?.ok) showToast(`Exported ${result.count} macro${result.count === 1 ? '' : 's'}`);
            else if (!result?.cancelled) showToast('Export failed', true);
        }

        async function importMacros() {
            if (!window.electronAPI?.macrosImport) return;
            const result = await window.electronAPI.macrosImport();
            if (result?.ok) {
                showToast(`Imported ${result.count} macro${result.count === 1 ? '' : 's'}`);
                scheduleSettingsSave();
                await renderMacrosPanel();
            } else if (!result?.cancelled) {
                showToast('Import failed — not a valid macros file', true);
            }
        }

        // ── Step editing ──
        async function removeMacroStep(id, index) {
            const m = getMacro(id);
            if (!m || !m.steps[index]) return;
            m.steps.splice(index, 1);
            await saveMacro(m);
        }

        // Insert a copy of a step right after it, so it can be tweaked separately.
        async function duplicateMacroStep(id, index) {
            const m = getMacro(id);
            if (!m || !m.steps[index]) return;
            const copy = JSON.parse(JSON.stringify(m.steps[index]));
            m.steps.splice(index + 1, 0, copy);
            await saveMacro(m);
            showToast('Step duplicated');
        }

        async function moveMacroStep(id, index, delta) {
            const m = getMacro(id);
            const j = index + delta;
            if (!m || !m.steps[index] || j < 0 || j >= m.steps.length) return;
            const [s] = m.steps.splice(index, 1);
            m.steps.splice(j, 0, s);
            await saveMacro(m);
        }

        async function setMacroDelay(id, index, value) {
            const m = getMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'delay') return;
            m.steps[index].ms = Math.min(600000, Math.max(0, Number(value) || 0));
            await saveMacro(m);
        }

        async function setMacroText(id, index, value) {
            const m = getMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'text') return;
            m.steps[index].s = String(value || '').slice(0, 2000);
            await saveMacro(m);
        }

        async function setMacroScroll(id, index, amount, direction) {
            const m = getMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'scroll') return;
            const cur = Number(m.steps[index].d) || 1;
            const n = amount !== null ? Math.min(100, Math.max(1, Math.round(Number(amount) || 1))) : Math.abs(cur);
            const sign = direction !== null ? (Number(direction) < 0 ? -1 : 1) : (cur < 0 ? -1 : 1);
            m.steps[index].d = n * sign;
            await saveMacro(m);
        }

        async function addMacroStep(id) {
            const m = getMacro(id);
            const select = document.getElementById(`macro-add-step-type-${id}`);
            if (!m || !select) return;
            const type = select.value;
            if (type === 'delay') {
                m.steps.push({ t: 'delay', ms: 500 });
                await saveMacro(m);
            } else if (type === 'scroll-up' || type === 'scroll-down') {
                m.steps.push({ t: 'scroll', d: type === 'scroll-up' ? 3 : -3 });
                await saveMacro(m);
            } else if (type === 'text') {
                m.steps.push({ t: 'text', s: '' });
                await saveMacro(m);
            } else if (type === 'move') {
                const index = m.steps.push({ t: 'move' }) - 1;
                await saveMacro(m);
                await armMacroPointCapture(id, index);
            } else if (type === 'click' || type === 'mdown' || type === 'mup') {
                // Mouse-button step: capture the next physical mouse button press
                // (Left/Right/Middle/side buttons), same flow as a key step below.
                const stepType = type === 'click' ? 'click' : (type === 'mdown' ? 'md' : 'mu');
                const btn = document.getElementById(`macro-add-step-btn-${id}`);
                if (btn) btn.textContent = 'press a mouse button…';
                await disableAllHotkeys();
                macrosMouseCapture = async (b) => {
                    await enableAllHotkeys();
                    if (b !== null) {
                        m.steps.push({ t: stepType, b });
                        await saveMacro(m);
                    } else {
                        await renderMacrosPanel();
                    }
                };
            } else {
                // Key step: capture the next physical key press.
                const btn = document.getElementById(`macro-add-step-btn-${id}`);
                if (btn) btn.textContent = 'press a key…';
                await disableAllHotkeys();
                macrosKeyCapture = async (keyName) => {
                    await enableAllHotkeys();
                    if (keyName) {
                        m.steps.push({ t: type, k: keyName });
                        await saveMacro(m);
                    } else {
                        await renderMacrosPanel();
                    }
                };
            }
        }

        // Arms the main-process Alt+X capture: the user hovers the target spot in
        // any window and presses Alt+X; the cursor position lands in the step.
        async function armMacroPointCapture(id, index) {
            if (!window.electronAPI?.macrosCaptureArm) return;
            if (macrosCaptureTarget) {
                // Second click while armed = cancel.
                await window.electronAPI.macrosCaptureCancel();
                return;
            }
            macrosCaptureTarget = { id, index };
            await renderMacrosPanel();
            showToast('Hover the target spot and press Alt + X');
            const p = await window.electronAPI.macrosCaptureArm();
            macrosCaptureTarget = null;
            if (p && p.error) {
                showToast('Alt + X is unavailable right now', true);
                await renderMacrosPanel();
                return;
            }
            if (!p || !Number.isFinite(p.x)) {
                await renderMacrosPanel();
                return;
            }
            const m = getMacro(id);
            const s = m && m.steps && m.steps[index];
            if (!m || !s || (s.t !== 'click' && s.t !== 'move')) return;
            s.x = p.x;
            s.y = p.y;
            showToast(`Position set (${p.x}, ${p.y})`);
            await saveMacro(m);
        }

        async function clearMacroClickPos(id, index) {
            const m = getMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'click') return;
            delete m.steps[index].x;
            delete m.steps[index].y;
            await saveMacro(m);
        }

        // ── Hotkey binding (own capture, separate from the fixed-hotkeys binder) ──
        async function startMacroHotkeyBind(kind, id) {
            if (macrosBindTarget || bindingTarget) {
                showToast('Already binding a hotkey. Press Esc to cancel.', true);
                return;
            }
            macrosBindTarget = { kind, id };
            await disableAllHotkeys();
            const btn = document.getElementById(kind === 'toggle' ? 'macro-toggle-hotkey-btn' : `macro-hotkey-btn-${id}`);
            if (btn) {
                btn.classList.add('listening');
                btn.textContent = kind === 'toggle' ? 'press key…' : 'press key / mouse…';
            }
            showToast(kind === 'toggle'
                ? 'Press a key combination or Esc to cancel'
                : 'Press a key or mouse button — Esc to clear');
        }

        // Flip macros on/off (the panel button; the toggle hotkey does the same in
        // the main process). Purely a convenience wrapper around the IPC.
        async function toggleMacrosArmed() {
            const next = !(macrosData && macrosData.armed);
            const data = await window.electronAPI.macrosSetArmed(next);
            if (data) macrosData = data;
            await renderMacrosPanel();
            showToast(next ? 'Macros enabled' : 'Macros disabled');
        }

        // Mouse-button capture while binding a macro trigger. Runs on the same
        // capture-phase pattern as the keydown binder (and before spotify-widget,
        // via stopImmediatePropagation) so the click can't also do its normal job.
        document.addEventListener('mousedown', async (e) => {
            if (macrosMouseCapture) {
                const b = MACRO_DOM_BUTTON_TO_STEP_B[e.button];
                if (b === undefined) return; // unknown button — keep waiting
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.button === 2) {
                    macrosSuppressContextMenu = true;
                    setTimeout(() => { macrosSuppressContextMenu = false; }, 1000);
                }
                const cb = macrosMouseCapture;
                macrosMouseCapture = null;
                await cb(b);
                return;
            }
            if (!macrosBindTarget) return;
            const name = MACRO_MOUSE_BUTTONS[e.button];
            if (!name) return; // unknown button — leave for normal use
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.button === 2) {
                macrosSuppressContextMenu = true;
                setTimeout(() => { macrosSuppressContextMenu = false; }, 1000);
            }
            const target = macrosBindTarget;
            macrosBindTarget = null;
            await enableAllHotkeys();
            if (target.kind === 'toggle') {
                // The enable/disable hotkey is registered through globalShortcut,
                // which is keyboard-only, so it can't be a mouse button.
                await renderMacrosPanel();
                showToast('The enable/disable hotkey must be a keyboard key', true);
                return;
            }
            const m = getMacro(target.id);
            if (m) {
                m.hotkey = name;
                await saveMacro(m);
                showToast(`Macro trigger set to ${MACRO_MOUSE_LABELS[name]}`);
            }
            await renderMacrosPanel();
        }, true);

        // Swallow the context menu that a right-click bind would otherwise raise.
        document.addEventListener('contextmenu', (e) => {
            if (macrosSuppressContextMenu) {
                macrosSuppressContextMenu = false;
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        document.addEventListener('keydown', async (e) => {
            // While capturing a macro key, this event must not reach any other
            // handler. spotify-widget.js listens on the same target (document,
            // capture phase) for Escape→close-settings, type-to-search, and the
            // Spotify media hotkeys; plain stopPropagation() doesn't stop
            // same-target listeners, so we use stopImmediatePropagation(). It
            // works because macros.js is loaded before spotify-widget.js, so this
            // listener runs first and can cut the others off.
            //
            // Mouse-button capture for a step only reacts to Escape (cancel);
            // any other key is swallowed while waiting for a mouse click.
            if (macrosMouseCapture) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.key === 'Escape') {
                    const cb = macrosMouseCapture;
                    macrosMouseCapture = null;
                    await cb(null);
                }
                return;
            }

            // Key-name capture for a "key" step has priority over hotkey binding.
            if (macrosKeyCapture) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.key === 'Escape') {
                    const cb = macrosKeyCapture;
                    macrosKeyCapture = null;
                    await cb(null);
                    return;
                }
                const keyName = macroEventToKeyName(e);
                if (!keyName) return;
                const cb = macrosKeyCapture;
                macrosKeyCapture = null;
                await cb(keyName);
                return;
            }

            if (!macrosBindTarget) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') {
                const target = macrosBindTarget;
                macrosBindTarget = null;
                await enableAllHotkeys();
                // Escape on a macro's hotkey clears it (leaves it unbound, shown
                // as a dash). The enable/disable hotkey can't be blank, so Escape
                // just cancels there.
                if (target.kind === 'macro') {
                    const m = getMacro(target.id);
                    if (m && m.hotkey) {
                        m.hotkey = null;
                        await saveMacro(m); // re-renders with the dash indicator
                        showToast('Hotkey cleared');
                        return;
                    }
                }
                await renderMacrosPanel();
                showToast('Binding cancelled');
                return;
            }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const target = macrosBindTarget;
            macrosBindTarget = null;
            const electronAccel = toElectronAccelerator(accel);
            if (target.kind === 'toggle') {
                const result = await window.electronAPI.macrosSetToggleHotkey(electronAccel);
                if (!result?.ok) showToast(result?.error === 'conflict' ? 'That key is used by a macro' : 'Hotkey unavailable', true);
                else showToast('Enable/disable hotkey updated');
                scheduleSettingsSave();
            } else {
                const m = getMacro(target.id);
                if (m) {
                    m.hotkey = electronAccel;
                    await saveMacro(m);
                    showToast('Macro hotkey updated');
                }
            }
            await enableAllHotkeys();
            await renderMacrosPanel();
        }, true);

        // Live status pushes from the main process (recording finished, playback
        // ended, F9 pressed, ...). The state fields are applied immediately (even
        // if the panel isn't mounted) so isMacroRecording() is always accurate,
        // then the panel re-renders with a full refetch.
        if (window.electronAPI?.onMacrosStatus) {
            window.electronAPI.onMacrosStatus((status) => {
                if (!macrosData) macrosData = { enabled: false, armed: true, toggleHotkey: 'F9', state: 'idle', activeMacroId: null, macros: [] };
                macrosData.enabled = status.enabled;
                if (typeof status.armed === 'boolean') macrosData.armed = status.armed;
                macrosData.state = status.state;
                macrosData.activeMacroId = status.activeMacroId;
                if (status.toggleHotkey) macrosData.toggleHotkey = status.toggleHotkey;
                if (status?.event === 'record-done') {
                    showToast(status.savedSteps ? 'Recording saved' : 'Recording was empty — nothing saved', !status.savedSteps);
                }
                renderMacrosPanel();
            });
        }
