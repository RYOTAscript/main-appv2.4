        // ── Free Up & Quiet mini widget (macOS) ──
        // The mac take on the FPS Optimizer: purge inactive memory and quit
        // background apps. macOS manages performance itself, so this is light and
        // safe. Backend main/macFreeUp.js. macOS-only.

        let fuApps = [];
        let fuSelected = new Set();
        let fuBusy = false;

        function isMacFreeUpEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.macFreeUp;
        }

        async function renderMacFreeUpPanel() {
            const panel = document.getElementById('mac-freeup-panel');
            if (!panel) return;
            if (!isMacFreeUpEnabled()) { panel.innerHTML = ''; return; }
            fuPaint(panel, 'Loading running apps…');
            await fuRefreshApps();
        }

        async function fuRefreshApps() {
            let res;
            try { res = await window.electronAPI.macFreeUpListApps(); } catch (e) { res = { ok: false, apps: [] }; }
            fuApps = (res && res.ok) ? res.apps : [];
            fuSelected = new Set(fuApps);       // default: all selected
            const panel = document.getElementById('mac-freeup-panel');
            if (panel) fuPaint(panel);
        }

        function fuPaint(panel, loadingMsg) {
            if (!panel || !isMacFreeUpEnabled()) return;
            const appRows = fuApps.length ? fuApps.map(name => `
                <label class="flex items-center gap-2 px-3 py-1.5 no-drag cursor-pointer">
                    <input type="checkbox" ${fuSelected.has(name) ? 'checked' : ''} onchange="fuToggle('${esc(name).replace(/'/g, "\\'")}', this.checked)" class="h-3.5 w-3.5 accent-white no-drag flex-shrink-0">
                    <span class="text-[11px] text-neutral-200 truncate">${esc(name)}</span>
                </label>`).join('')
                : `<p class="px-3 py-2 text-[11px] text-neutral-500">${esc(loadingMsg || 'No background apps to quit.')}</p>`;

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <button type="button" onclick="fuFreeMemory(this)" ${fuBusy ? 'disabled' : ''}
                    class="w-full px-3 py-2.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded-xl text-xs transition-colors no-drag">
                    <i class="fas fa-memory mr-1.5"></i>Free inactive memory
                </button>
                <div>
                    <div class="flex items-center justify-between mb-1">
                        <p class="text-[11px] text-neutral-300">Background apps</p>
                        <button type="button" onclick="fuRefreshApps()" class="text-[10px] text-neutral-500 hover:text-white no-drag"><i class="fas fa-rotate mr-1"></i>Refresh</button>
                    </div>
                    <div class="rounded-xl border border-white/10 bg-neutral-800/20 divide-y divide-white/5 max-h-52 overflow-y-auto">${appRows}</div>
                </div>
                <button type="button" onclick="fuQuit()" ${(fuBusy || !fuApps.length) ? 'disabled' : ''}
                    class="w-full px-3 py-2.5 bg-white text-black disabled:opacity-40 rounded-xl text-xs font-medium no-drag hover:bg-neutral-200 transition-colors">
                    <i class="fas fa-power-off mr-1.5"></i>Quit selected apps
                </button>
                <p class="text-[10px] text-neutral-600 text-center">Apps are asked to quit gracefully — unsaved work will prompt you.</p>
            </div>`;
        }

        function fuToggle(name, on) { if (on) fuSelected.add(name); else fuSelected.delete(name); }

        async function fuFreeMemory(btn) {
            if (fuBusy) return;
            fuBusy = true; if (btn) btn.disabled = true;
            try {
                const r = await window.electronAPI.macFreeUpFreeMemory();
                showToast(r && r.ok ? 'Freed inactive memory' : 'Couldn’t free memory', !(r && r.ok));
            } catch (e) { showToast('Couldn’t free memory', true); }
            finally { fuBusy = false; if (btn) btn.disabled = false; }
        }

        async function fuQuit() {
            if (fuBusy || !fuSelected.size) return;
            fuBusy = true;
            try {
                const r = await window.electronAPI.macFreeUpQuitApps([...fuSelected]);
                if (r && r.ok) showToast(`Quit ${r.quit.length} app${r.quit.length === 1 ? '' : 's'}${r.failed.length ? `, ${r.failed.length} declined` : ''}`);
                else showToast('Couldn’t quit apps', true);
            } catch (e) { showToast('Couldn’t quit apps', true); }
            finally { fuBusy = false; await fuRefreshApps(); }
        }
