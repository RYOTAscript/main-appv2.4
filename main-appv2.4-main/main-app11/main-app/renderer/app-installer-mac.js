        // ── App Installer (Homebrew) mini widget (macOS) ──
        // The mac substitute for the winget App Installer: tick popular apps and
        // install them via Homebrew Cask. Backend main/appInstallerMac.js validates
        // every id against the catalog. macOS-only widget.

        let aimCatalog = [];
        let aimInstalled = new Set();
        let aimSelected = new Set();
        let aimResults = {};      // id -> { state, message }
        let aimRunning = false;
        let aimHooked = false;
        let aimBrew = false;

        function isAppInstallerMacEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.appInstallerMac;
        }

        function aimOnProgress(p) {
            if (!p) return;
            if (p.done) { aimRunning = false; renderAppInstallerMacPanel(); return; }
            if (p.id) {
                aimResults[p.id] = { state: p.state, message: p.message };
                if (p.state === 'done') aimInstalled.add(p.id);
            }
            aimPaint();
        }

        async function renderAppInstallerMacPanel() {
            const panel = document.getElementById('app-installer-mac-panel');
            if (!panel) return;
            if (!isAppInstallerMacEnabled()) { panel.innerHTML = ''; return; }

            if (!aimHooked && window.electronAPI.onAppInstallerMacProgress) {
                window.electronAPI.onAppInstallerMacProgress(aimOnProgress);
                aimHooked = true;
            }

            panel.innerHTML = `<p class="mt-3 text-[11px] text-neutral-500">Loading catalog…</p>`;
            let res;
            try { res = await window.electronAPI.appInstallerMacCatalog(); } catch (e) { res = { ok: false }; }
            if (!res || !res.ok) { panel.innerHTML = `<p class="mt-3 text-xs text-red-400">Couldn't load the app catalog.</p>`; return; }
            aimCatalog = res.catalog || [];
            aimBrew = !!(res.brew && res.brew.available);

            if (!aimBrew) {
                panel.innerHTML = macToolMissingMarkup('brew', 'Homebrew', 'renderAppInstallerMacPanel');
                return;
            }

            // Refresh the installed set.
            try {
                const inst = await window.electronAPI.appInstallerMacInstalled();
                if (inst && inst.ok) aimInstalled = new Set(inst.installed);
            } catch (e) { /* best-effort */ }

            aimPaint();
        }

        function aimAppRow(app) {
            const installed = aimInstalled.has(app.id);
            const r = aimResults[app.id];
            const checked = aimSelected.has(app.id);
            let right = '';
            if (r && r.state === 'installing') right = `<i class="fas fa-circle-notch fa-spin text-[10px] text-neutral-400"></i>`;
            else if (installed) right = `<i class="fas fa-check text-[10px] text-emerald-400"></i>`;
            else if (r && r.state === 'error') right = `<i class="fas fa-triangle-exclamation text-[10px] text-red-400" title="${esc(r.message || 'Failed')}"></i>`;
            const disabled = installed || aimRunning;
            return `<label class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border ${checked ? 'border-white/30 bg-white/5' : 'border-neutral-700/50 bg-neutral-800/20'} ${disabled ? 'opacity-60' : 'hover:border-neutral-600 cursor-pointer'} transition-colors no-drag" title="${esc(app.id)}">
                <span class="flex items-center gap-2 min-w-0">
                    <input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}
                        onchange="aimToggle('${esc(app.id)}', this.checked)" class="h-3.5 w-3.5 accent-white no-drag flex-shrink-0">
                    <span class="text-[11px] text-neutral-200 truncate">${esc(app.name)}</span>
                </span>
                ${right}
            </label>`;
        }

        function aimPaint() {
            const panel = document.getElementById('app-installer-mac-panel');
            if (!panel || !isAppInstallerMacEnabled() || !aimBrew) return;

            const sections = aimCatalog.map(group => `
                <div>
                    <p class="text-[11px] uppercase tracking-wide text-neutral-500 mb-1 mt-2">${esc(group.category)}</p>
                    <div class="grid grid-cols-2 gap-1.5">${group.apps.map(aimAppRow).join('')}</div>
                </div>`).join('');

            const count = aimSelected.size;
            panel.innerHTML = `<div class="mt-3 space-y-2">
                <p class="text-[11px] text-neutral-500">Tick apps and install them with Homebrew — downloaded from each app’s real publisher. Installed apps are ticked green.</p>
                ${sections}
                <div class="sticky bottom-0 pt-2 flex items-center gap-2 bg-gradient-to-t from-black/40 to-transparent">
                    <button type="button" onclick="aimInstall()" ${(!count || aimRunning) ? 'disabled' : ''}
                        class="flex-1 px-3 py-2.5 bg-white text-black disabled:opacity-40 rounded-xl text-xs font-medium no-drag hover:bg-neutral-200 transition-colors">
                        ${aimRunning ? '<i class="fas fa-circle-notch fa-spin mr-1.5"></i>Installing…' : `<i class="fas fa-download mr-1.5"></i>Install ${count || ''}`.trim()}
                    </button>
                    ${aimRunning ? `<button type="button" onclick="aimCancel()" class="px-3 py-2.5 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs no-drag">Stop</button>` : ''}
                </div>
            </div>`;
        }

        function aimToggle(id, on) {
            if (on) aimSelected.add(id); else aimSelected.delete(id);
            aimPaint();
        }

        async function aimInstall() {
            if (aimRunning || !aimSelected.size) return;
            aimRunning = true;
            aimResults = {};
            aimPaint();
            try {
                const res = await window.electronAPI.appInstallerMacInstall([...aimSelected]);
                if (res && res.needsBrew) { aimRunning = false; renderAppInstallerMacPanel(); return; }
                if (!res || !res.ok) { aimRunning = false; showToast('Couldn’t start the install', true); aimPaint(); }
            } catch (e) {
                aimRunning = false; showToast('Install failed to start', true); aimPaint();
            }
        }

        async function aimCancel() {
            try { await window.electronAPI.appInstallerMacCancel(); } catch (e) { /* ignore */ }
            showToast('Stopping after the current app…');
        }
