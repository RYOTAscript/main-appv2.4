        // ── Dock Styler mini widget (macOS) ──
        // The mac substitute for Translucent Taskbar: style the Dock via reversible
        // com.apple.dock defaults. Backend in main/dockStyler.js. macOS-only widget
        // (registry `platforms: ['darwin']`), so this panel only ever renders on mac.

        function isDockStylerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.dockStyler;
        }

        function dockControlMarkup(s, value) {
            const v = value == null ? s.default : value;
            if (s.type === 'bool') {
                const on = !!v;
                return `
                    <label class="flex items-center justify-between gap-3 py-1.5 no-drag cursor-pointer">
                        <span class="text-xs text-neutral-300">${esc(s.label)}</span>
                        <span class="ios-toggle">
                            <input type="checkbox" class="ios-toggle-input" ${on ? 'checked' : ''}
                                onchange="dockStylerSet(${jsAttr(s.key)}, this.checked)">
                            <span class="ios-toggle-track"></span>
                        </span>
                    </label>`;
            }
            if (s.type === 'enum') {
                const opts = s.options.map(o =>
                    `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
                return `
                    <label class="flex items-center justify-between gap-3 py-1.5 no-drag">
                        <span class="text-xs text-neutral-300">${esc(s.label)}</span>
                        <select onchange="dockStylerSet(${jsAttr(s.key)}, this.value)"
                            class="bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1 text-[11px] text-neutral-200 focus:outline-none focus:border-neutral-600 no-drag capitalize">${opts}</select>
                    </label>`;
            }
            // int / float → range slider with a live value readout.
            const step = s.type === 'float' ? 0.1 : 1;
            return `
                <div class="py-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-xs text-neutral-300">${esc(s.label)}</span>
                        <span id="dock-val-${esc(s.key)}" class="text-[11px] text-neutral-400 tabular-nums">${esc(String(v))}</span>
                    </div>
                    <input type="range" min="${s.min}" max="${s.max}" step="${step}" value="${esc(String(v))}"
                        oninput="document.getElementById(${jsAttr(`dock-val-${s.key}`)}).textContent = this.value"
                        onchange="dockStylerSet(${jsAttr(s.key)}, this.value)"
                        class="w-full mt-1.5 accent-white no-drag">
                </div>`;
        }

        async function renderDockStylerPanel() {
            const panel = document.getElementById('dock-styler-panel');
            if (!panel) return;
            if (!isDockStylerEnabled()) { panel.innerHTML = ''; return; }

            panel.innerHTML = `<p class="mt-3 text-[11px] text-neutral-500">Reading Dock settings…</p>`;
            let res;
            try { res = await window.electronAPI.dockStylerGet(); } catch (e) { res = { ok: false }; }
            if (!res || !res.ok) {
                panel.innerHTML = `<p class="mt-3 text-xs text-red-400">Couldn't read the Dock settings.</p>`;
                return;
            }

            const controls = res.settings.map(s => dockControlMarkup(s, res.values[s.key])).join('');
            panel.innerHTML = `<div class="mt-3 space-y-1">
                <p class="text-[11px] text-neutral-500 mb-1">Changes apply instantly and are fully reversible.</p>
                <div class="rounded-xl border border-white/10 bg-neutral-800/20 px-3 py-1 divide-y divide-white/5">${controls}</div>
                <button type="button" onclick="dockStylerReset()"
                    class="mt-3 w-full px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs transition-colors no-drag">
                    <i class="fas fa-rotate-left mr-1.5"></i>Restore Dock defaults
                </button>
            </div>`;
        }

        async function dockStylerSet(key, value) {
            try {
                const r = await window.electronAPI.dockStylerSet(key, value);
                if (!r || !r.ok) showToast('Couldn’t apply that Dock setting', true);
            } catch (e) {
                showToast('Dock setting failed', true);
            }
        }

        async function dockStylerReset() {
            try {
                await window.electronAPI.dockStylerReset();
                showToast('Dock restored to defaults');
                renderDockStylerPanel();
            } catch (e) {
                showToast('Couldn’t reset the Dock', true);
            }
        }
