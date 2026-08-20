        // ── macOS Tweaks mini widget (macOS) ──
        // The mac substitute for the Windows Debloat "Tweaks" tab: reversible
        // per-user `defaults` power-user toggles. Backend in main/macTweaks.js.
        // macOS-only widget, so this panel only ever renders on mac.

        function isMacTweaksEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.macTweaks;
        }

        function macTweakRow(t, on) {
            return `
                <label class="flex items-center justify-between gap-3 py-1.5 no-drag cursor-pointer">
                    <span class="text-xs text-neutral-300">${esc(t.label)}</span>
                    <input type="checkbox" ${on ? 'checked' : ''}
                        onchange="macTweaksSet('${esc(t.id)}', this.checked, this)"
                        class="h-4 w-4 accent-white no-drag flex-shrink-0">
                </label>`;
        }

        async function renderMacTweaksPanel() {
            const panel = document.getElementById('mac-tweaks-panel');
            if (!panel) return;
            if (!isMacTweaksEnabled()) { panel.innerHTML = ''; return; }

            panel.innerHTML = `<p class="mt-3 text-[11px] text-neutral-500">Reading current settings…</p>`;
            let res;
            try { res = await window.electronAPI.macTweaksGet(); } catch (e) { res = { ok: false }; }
            if (!res || !res.ok) {
                panel.innerHTML = `<p class="mt-3 text-xs text-red-400">Couldn't read macOS settings.</p>`;
                return;
            }

            // Group tweaks by their `group` field, in first-seen order.
            const groups = [];
            const byGroup = {};
            for (const t of res.tweaks) {
                if (!byGroup[t.group]) { byGroup[t.group] = []; groups.push(t.group); }
                byGroup[t.group].push(t);
            }

            const sections = groups.map(g => `
                <div>
                    <p class="text-[11px] uppercase tracking-wide text-neutral-500 mb-1 mt-2">${esc(g)}</p>
                    <div class="rounded-xl border border-white/10 bg-neutral-800/20 px-3 py-0.5 divide-y divide-white/5">
                        ${byGroup[g].map(t => macTweakRow(t, res.state[t.id])).join('')}
                    </div>
                </div>`).join('');

            panel.innerHTML = `<div class="mt-3 space-y-2">
                <p class="text-[11px] text-neutral-500">Every toggle is a real macOS setting for your account — flip it back any time. Nothing is installed.</p>
                ${sections}
            </div>`;
        }

        async function macTweaksSet(id, on, el) {
            if (el) el.disabled = true;
            try {
                const r = await window.electronAPI.macTweaksSet(id, on);
                if (!r || !r.ok) {
                    showToast('Couldn’t apply that tweak', true);
                    if (el) el.checked = !on; // revert the visual toggle
                }
            } catch (e) {
                showToast('Tweak failed', true);
                if (el) el.checked = !on;
            } finally {
                if (el) el.disabled = false;
            }
        }
