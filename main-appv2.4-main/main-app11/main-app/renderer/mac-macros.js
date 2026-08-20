        // ── Macros mini widget (macOS) ──
        // Build-and-play macros for macOS. Recording real input isn't possible on
        // mac, so you build a macro from steps (type text, press a key, wait, click
        // or move) and play it — by button or a global hotkey. Keyboard-only macros
        // run with no install (just Accessibility permission); mouse steps use
        // cliclick (1-click install). Backend main/macMacros.js. macOS-only.

        let mmMacros = [];
        let mmEnabled = false;
        let mmCliclick = false;
        let mmEditing = null;       // the macro being edited, or null (list view)
        let mmCapturing = false;    // capturing a hotkey?
        let mmKeyHandler = null;

        const MM_NAMED_KEYS = ['return', 'tab', 'space', 'delete', 'escape', 'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', 'home', 'end', 'page-up', 'page-down', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];

        function isMacMacrosEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.macMacros;
        }

        async function renderMacMacrosPanel() {
            const panel = document.getElementById('mac-macros-panel');
            if (!panel) return;
            if (!isMacMacrosEnabled()) { panel.innerHTML = ''; mmStopCapture(); return; }

            let res;
            try { res = await window.electronAPI.macMacrosGet(); } catch (e) { res = null; }
            if (res && res.ok) {
                mmMacros = res.macros || [];
                mmEnabled = !!res.enabled;
                mmCliclick = !!(res.tools && res.tools.cliclick);
            }
            if (mmEditing) mmRenderEditor(panel); else mmRenderList(panel);
        }

        function mmStepLabel(s) {
            if (s.t === 'text') return `Type “${esc(String(s.s || '').slice(0, 40))}”`;
            if (s.t === 'delay') return `Wait ${esc(String(s.ms))} ms`;
            if (s.t === 'key') { const mods = (s.mods || []).join('+'); return `Press ${esc((mods ? mods + '+' : '') + s.key)}`; }
            if (s.t === 'click') return `Click at ${esc(String(s.x))}, ${esc(String(s.y))}`;
            if (s.t === 'move') return `Move to ${esc(String(s.x))}, ${esc(String(s.y))}`;
            return '—';
        }

        function mmRenderList(panel) {
            const rows = mmMacros.map(m => `
                <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-white/10 bg-neutral-800/20">
                    <span class="min-w-0">
                        <span class="block text-xs text-neutral-200 truncate">${esc(m.name)}</span>
                        <span class="block text-[10px] text-neutral-500 truncate">${m.steps.length} step${m.steps.length === 1 ? '' : 's'}${m.hotkey ? ` · ${esc(m.hotkey)}` : ''}</span>
                    </span>
                    <span class="flex items-center gap-1 flex-shrink-0">
                        <button type="button" onclick="mmPlay('${esc(m.id)}')" title="Play" class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-emerald-400 no-drag"><i class="fas fa-play text-[11px]"></i></button>
                        <button type="button" onclick="mmEdit('${esc(m.id)}')" title="Edit" class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 no-drag"><i class="fas fa-pen text-[11px]"></i></button>
                        <button type="button" onclick="mmDelete('${esc(m.id)}')" title="Delete" class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-red-400 no-drag"><i class="fas fa-trash-can text-[11px]"></i></button>
                    </span>
                </div>`).join('');

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <label class="flex items-center justify-between gap-3 no-drag cursor-pointer">
                    <span class="text-xs text-neutral-300">Enable macros &amp; hotkeys</span>
                    <span class="ios-toggle">
                        <input type="checkbox" class="ios-toggle-input" ${mmEnabled ? 'checked' : ''} onchange="mmSetEnabled(this.checked)">
                        <span class="ios-toggle-track"></span>
                    </span>
                </label>
                <p class="text-[11px] text-neutral-500">Recording isn’t available on macOS — build a macro from steps, then play it by button or hotkey. Keyboard macros need Accessibility permission; mouse steps use cliclick.</p>
                <div class="space-y-1.5">${rows || '<p class="text-[11px] text-neutral-500">No macros yet.</p>'}</div>
                <button type="button" onclick="mmNew()" class="w-full px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs no-drag transition-colors"><i class="fas fa-plus mr-1.5"></i>New macro</button>
            </div>`;
        }

        function mmRenderEditor(panel) {
            const m = mmEditing;
            const stepRows = m.steps.map((s, i) => `
                <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-neutral-800/30 border border-neutral-700/40">
                    <span class="text-[11px] text-neutral-200 truncate">${i + 1}. ${mmStepLabel(s)}</span>
                    <button type="button" onclick="mmRemoveStep(${i})" class="text-neutral-500 hover:text-red-400 no-drag flex-shrink-0"><i class="fas fa-xmark text-[11px]"></i></button>
                </div>`).join('');

            const keyOpts = MM_NAMED_KEYS.map(k => `<option value="${k}">${k}</option>`).join('');

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <button type="button" onclick="mmBack()" class="text-[11px] text-neutral-400 hover:text-white no-drag"><i class="fas fa-chevron-left mr-1"></i>All macros</button>
                <input type="text" id="mm-name" value="${esc(m.name)}" placeholder="Macro name" oninput="mmEditing.name=this.value"
                    class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-neutral-600 no-drag">

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1">Steps</p>
                    <div class="space-y-1">${stepRows || '<p class="text-[11px] text-neutral-500 px-1">No steps yet — add one below.</p>'}</div>
                </div>

                <div class="rounded-xl border border-white/10 bg-neutral-800/20 p-2.5 space-y-2">
                    <select id="mm-step-type" onchange="mmRenderStepInputs()" class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1.5 text-[11px] no-drag focus:outline-none focus:border-neutral-500">
                        <option value="text">Type text</option>
                        <option value="key">Press key</option>
                        <option value="delay">Wait</option>
                        <option value="click">Click at X,Y</option>
                        <option value="move">Move to X,Y</option>
                    </select>
                    <div id="mm-step-inputs"></div>
                    <button type="button" onclick="mmAddStep()" class="w-full px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-[11px] no-drag transition-colors"><i class="fas fa-plus mr-1"></i>Add step</button>
                </div>

                <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] text-neutral-300">Hotkey</span>
                    <button type="button" onclick="mmCaptureHotkey()" class="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[11px] text-neutral-200 no-drag">${mmCapturing ? 'Press keys…' : (m.hotkey ? esc(m.hotkey) : 'Set hotkey')}</button>
                </div>

                <div class="flex items-center gap-2">
                    <button type="button" onclick="mmSave()" class="flex-1 px-3 py-2 bg-white text-black rounded-xl text-xs font-medium no-drag hover:bg-neutral-200 transition-colors"><i class="fas fa-check mr-1.5"></i>Save</button>
                    <button type="button" onclick="mmPlayDraft()" class="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs no-drag"><i class="fas fa-play mr-1"></i>Test</button>
                </div>
                <datalist id="mm-key-list">${keyOpts}</datalist>
            </div>`;
            mmRenderStepInputs();
        }

        function mmRenderStepInputs() {
            const wrap = document.getElementById('mm-step-inputs');
            const type = document.getElementById('mm-step-type');
            if (!wrap || !type) return;
            const t = type.value;
            const num = 'w-16 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-[11px] text-center no-drag focus:outline-none focus:border-neutral-500';
            if (t === 'text') {
                wrap.innerHTML = `<input type="text" id="mm-in-text" placeholder="text to type" class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-[11px] no-drag focus:outline-none focus:border-neutral-500">`;
            } else if (t === 'key') {
                wrap.innerHTML = `<div class="space-y-1.5">
                    <input type="text" id="mm-in-key" list="mm-key-list" placeholder="key (e.g. return, a, f5)" spellcheck="false" class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-[11px] no-drag focus:outline-none focus:border-neutral-500">
                    <div class="flex items-center gap-2 text-[10px] text-neutral-400">
                        ${['cmd', 'opt', 'ctrl', 'shift'].map(mod => `<label class="flex items-center gap-1 no-drag cursor-pointer"><input type="checkbox" id="mm-mod-${mod}" class="h-3 w-3 accent-white no-drag">${mod}</label>`).join('')}
                    </div>
                </div>`;
            } else if (t === 'delay') {
                wrap.innerHTML = `<div class="flex items-center gap-2"><input type="number" id="mm-in-ms" min="0" value="500" class="${num}"><span class="text-[10px] text-neutral-500">ms</span></div>`;
            } else { // click / move
                wrap.innerHTML = `<div class="flex items-center gap-2"><input type="number" id="mm-in-x" placeholder="X" class="${num}"><input type="number" id="mm-in-y" placeholder="Y" class="${num}"><span class="text-[10px] text-neutral-500">screen coords</span></div>`;
            }
        }

        function mmAddStep() {
            const t = document.getElementById('mm-step-type')?.value;
            if (!t || !mmEditing) return;
            let step = null;
            if (t === 'text') { const v = document.getElementById('mm-in-text')?.value || ''; if (!v) { showToast('Enter some text', true); return; } step = { t: 'text', s: v }; }
            else if (t === 'key') {
                const k = (document.getElementById('mm-in-key')?.value || '').trim().toLowerCase();
                if (!k) { showToast('Enter a key', true); return; }
                const mods = ['cmd', 'opt', 'ctrl', 'shift'].filter(mod => document.getElementById('mm-mod-' + mod)?.checked);
                step = { t: 'key', key: k, mods };
            } else if (t === 'delay') { const ms = Math.max(0, Number(document.getElementById('mm-in-ms')?.value) || 0); step = { t: 'delay', ms }; }
            else { const x = Number(document.getElementById('mm-in-x')?.value), y = Number(document.getElementById('mm-in-y')?.value); if (!Number.isFinite(x) || !Number.isFinite(y)) { showToast('Enter X and Y', true); return; } step = { t, x, y }; }
            mmEditing.steps.push(step);
            mmRenderEditor(document.getElementById('mac-macros-panel'));
        }

        function mmRemoveStep(i) { if (mmEditing) { mmEditing.steps.splice(i, 1); mmRenderEditor(document.getElementById('mac-macros-panel')); } }

        function mmNew() { mmEditing = { id: '', name: 'New macro', hotkey: '', steps: [] }; renderMacMacrosPanel(); }
        function mmEdit(id) { const m = mmMacros.find(x => x.id === id); if (m) { mmEditing = JSON.parse(JSON.stringify(m)); renderMacMacrosPanel(); } }
        function mmBack() { mmStopCapture(); mmEditing = null; renderMacMacrosPanel(); }

        async function mmSave() {
            if (!mmEditing) return;
            mmEditing.name = document.getElementById('mm-name')?.value || mmEditing.name;
            if (!mmEditing.steps.length) { showToast('Add at least one step', true); return; }
            try {
                const res = await window.electronAPI.macMacrosSave(mmEditing);
                if (res && res.ok) { showToast('Macro saved'); mmStopCapture(); mmEditing = null; renderMacMacrosPanel(); }
                else showToast('Couldn’t save macro', true);
            } catch (e) { showToast('Couldn’t save macro', true); }
        }

        async function mmDelete(id) {
            try { await window.electronAPI.macMacrosDelete(id); renderMacMacrosPanel(); } catch (e) { /* ignore */ }
        }

        async function mmSetEnabled(on) {
            try { await window.electronAPI.macMacrosSetEnabled(on); mmEnabled = on; } catch (e) { /* ignore */ }
        }

        async function mmPlayResult(res) {
            if (res && res.ok) { showToast('Played'); return; }
            if (res && res.needsTool) {
                const panel = document.getElementById('mac-macros-panel');
                if (panel) panel.innerHTML = macToolMissingMarkup(res.needsTool, res.toolLabel, 'renderMacMacrosPanel');
                return;
            }
            showToast((res && res.error) || 'Playback failed', true);
        }
        async function mmPlay(id) { try { await mmPlayResult(await window.electronAPI.macMacrosPlay(id)); } catch (e) { showToast('Playback failed', true); } }
        async function mmPlayDraft() {
            if (!mmEditing || !mmEditing.steps.length) { showToast('Add a step first', true); return; }
            // Save first (so it has an id), then play.
            try { const s = await window.electronAPI.macMacrosSave(mmEditing); if (s && s.ok) { mmEditing.id = s.macro.id; await mmPlayResult(await window.electronAPI.macMacrosPlay(s.macro.id)); } }
            catch (e) { showToast('Couldn’t test', true); }
        }

        // ── Hotkey capture ──
        function mmStopCapture() { if (mmKeyHandler) { document.removeEventListener('keydown', mmKeyHandler, true); mmKeyHandler = null; } mmCapturing = false; }
        function mmNormKey(e) {
            const c = e.code || '';
            if (/^Key([A-Z])$/.test(c)) return c.slice(3);
            if (/^Digit([0-9])$/.test(c)) return c.slice(5);
            if (/^F([0-9]{1,2})$/.test(c)) return c;
            const map = { Space: 'Space', Enter: 'Return', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape' };
            return map[c] || null;
        }
        function mmCaptureHotkey() {
            if (mmCapturing) { mmStopCapture(); mmRenderEditor(document.getElementById('mac-macros-panel')); return; }
            mmCapturing = true;
            mmRenderEditor(document.getElementById('mac-macros-panel'));
            mmKeyHandler = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for a real key
                const parts = [];
                if (e.ctrlKey) parts.push('Control');
                if (e.altKey) parts.push('Alt');
                if (e.shiftKey) parts.push('Shift');
                if (e.metaKey) parts.push('Command');
                const key = mmNormKey(e);
                if (!key) return;
                parts.push(key);
                if (mmEditing) mmEditing.hotkey = parts.join('+');
                mmStopCapture();
                mmRenderEditor(document.getElementById('mac-macros-panel'));
            };
            document.addEventListener('keydown', mmKeyHandler, true);
        }
