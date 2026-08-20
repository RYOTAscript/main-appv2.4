        // ── App Uninstaller mini widget (macOS) ──
        // The mac substitute for the Windows Deep Uninstaller. Lists installed
        // apps, finds each one's ~/Library leftovers, and moves the app + the
        // leftovers you tick to the Trash (reversible). Backend guards every path
        // against a fixed allow-list (main/appUninstaller.logic.js). macOS-only.

        let auApps = [];
        let auSearch = '';
        let auSelected = null;   // the app being uninstalled
        let auLeftovers = [];
        let auBusy = false;

        function isAppUninstallerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.appUninstaller;
        }

        function auFmtBytes(n) {
            if (!n || n < 1024) return `${n || 0} B`;
            const u = ['KB', 'MB', 'GB', 'TB'];
            let i = -1; let v = n;
            do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
            return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
        }

        async function renderAppUninstallerPanel() {
            const panel = document.getElementById('app-uninstaller-panel');
            if (!panel) return;
            if (!isAppUninstallerEnabled()) { panel.innerHTML = ''; return; }

            if (auSelected) { renderAuDetail(panel); return; }

            panel.innerHTML = `<p class="mt-3 text-[11px] text-neutral-500">Finding installed apps…</p>`;
            let res;
            try { res = await window.electronAPI.appUninstallerList(); } catch (e) { res = { ok: false }; }
            if (!res || !res.ok) { panel.innerHTML = `<p class="mt-3 text-xs text-red-400">Couldn't list applications.</p>`; return; }
            auApps = res.apps || [];
            renderAuList(panel);
        }

        function renderAuList(panel) {
            const q = auSearch.trim().toLowerCase();
            const shown = auApps.filter(a => !q || a.name.toLowerCase().includes(q) || (a.bundleId || '').toLowerCase().includes(q));
            const rows = shown.map(a => {
                if (a.protected) {
                    return `<div class="flex items-center justify-between px-3 py-2 opacity-40 select-none" title="System / Apple app — protected">
                        <span class="text-xs text-neutral-300 truncate">${esc(a.name)}</span>
                        <i class="fas fa-lock text-[10px] text-neutral-500"></i></div>`;
                }
                return `<button type="button" onclick='auSelect(${JSON.stringify(a.path)})'
                    class="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 transition-colors no-drag text-left">
                    <span class="text-xs text-neutral-200 truncate">${esc(a.name)}</span>
                    <i class="fas fa-chevron-right text-[10px] text-neutral-600"></i></button>`;
            }).join('');

            panel.innerHTML = `<div class="mt-3 space-y-2">
                <input type="text" placeholder="Search apps…" value="${esc(auSearch)}"
                    oninput="auOnSearch(this.value)"
                    class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-neutral-600 no-drag">
                <p class="text-[11px] text-neutral-500">Pick an app to uninstall it and sweep its leftover files. Everything is moved to the Trash — nothing is permanently deleted.</p>
                <div class="rounded-xl border border-white/10 bg-neutral-800/20 divide-y divide-white/5 max-h-72 overflow-y-auto">
                    ${rows || '<p class="px-3 py-3 text-xs text-neutral-500">No matching apps.</p>'}
                </div>
            </div>`;
        }

        function auOnSearch(v) {
            auSearch = v;
            const panel = document.getElementById('app-uninstaller-panel');
            if (panel && !auSelected) renderAuList(panel);
        }

        async function auSelect(appPath) {
            const app = auApps.find(a => a.path === appPath);
            if (!app || app.protected) return;
            auSelected = app;
            auLeftovers = [];
            const panel = document.getElementById('app-uninstaller-panel');
            if (panel) panel.innerHTML = `<p class="mt-3 text-[11px] text-neutral-500">Scanning for leftover files…</p>`;
            let res;
            try { res = await window.electronAPI.appUninstallerScan(app); } catch (e) { res = { ok: false }; }
            auLeftovers = (res && res.ok && res.leftovers) ? res.leftovers : [];
            if (panel) renderAuDetail(panel);
        }

        function auBack() {
            auSelected = null;
            auLeftovers = [];
            renderAppUninstallerPanel();
        }

        function renderAuDetail(panel) {
            const app = auSelected;
            const leftoverRows = auLeftovers.map((l, i) => `
                <label class="flex items-center gap-2 px-3 py-1.5 no-drag cursor-pointer">
                    <input type="checkbox" checked data-au-idx="${i}" class="h-3.5 w-3.5 accent-white no-drag flex-shrink-0">
                    <span class="min-w-0 flex-1">
                        <span class="block text-[11px] text-neutral-200 truncate">${esc(l.name)}</span>
                        <span class="block text-[10px] text-neutral-500 truncate">${esc(l.root)} · ${auFmtBytes(l.size)}</span>
                    </span>
                </label>`).join('');

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <button type="button" onclick="auBack()" class="text-[11px] text-neutral-400 hover:text-white no-drag"><i class="fas fa-chevron-left mr-1"></i>All apps</button>
                <div class="rounded-xl border border-white/10 bg-neutral-800/20 p-3">
                    <p class="text-sm text-white font-medium truncate">${esc(app.name)}</p>
                    <p class="text-[10px] text-neutral-500 truncate">${esc(app.bundleId || 'no bundle id')}</p>
                </div>
                <div>
                    <p class="text-[11px] text-neutral-300 mb-1">Leftover files ${auLeftovers.length ? `(${auLeftovers.length})` : ''}</p>
                    ${auLeftovers.length
                        ? `<div class="rounded-xl border border-white/10 bg-neutral-800/20 divide-y divide-white/5 max-h-56 overflow-y-auto">${leftoverRows}</div>`
                        : `<p class="text-[11px] text-neutral-500">No leftover files found — just the app itself.</p>`}
                </div>
                <button type="button" onclick="auRemove()" ${auBusy ? 'disabled' : ''}
                    class="w-full px-3 py-2.5 bg-red-500/90 hover:bg-red-500 disabled:opacity-50 rounded-xl text-xs font-medium text-white transition-colors no-drag">
                    <i class="fas fa-trash-can mr-1.5"></i>Move app${auLeftovers.length ? ' + selected leftovers' : ''} to Trash
                </button>
                <p class="text-[10px] text-neutral-600 text-center">Items go to the Trash — recover them there if needed.</p>
            </div>`;
        }

        async function auRemove() {
            if (auBusy || !auSelected) return;
            auBusy = true;
            const panel = document.getElementById('app-uninstaller-panel');
            const checked = panel ? [...panel.querySelectorAll('input[data-au-idx]:checked')].map(el => auLeftovers[Number(el.dataset.auIdx)].path) : [];
            try {
                const res = await window.electronAPI.appUninstallerRemove({ appPath: auSelected.path, bundleId: auSelected.bundleId, leftovers: checked });
                if (res && res.ok) showToast(`Moved ${res.trashed.length} item${res.trashed.length === 1 ? '' : 's'} to Trash`);
                else if (res && res.trashed) showToast(`Trashed ${res.trashed.length}, ${res.failed.length} failed`, true);
                else showToast('Uninstall failed', true);
            } catch (e) {
                showToast('Uninstall failed', true);
            } finally {
                auBusy = false;
                auBack(); // back to a refreshed list
            }
        }
