        // ── App Installer mini widget (Ninite-style bulk installer) ──
        // A category grid of popular apps with a checkbox each; tick a bunch, hit
        // the green Get button, and they install silently one after another. The
        // actual installing (winget) lives in the main process
        // (main/appInstaller.js); this file is the panel UI — the grid, the
        // selection state, and the live per-app progress list.
        //
        // The panel div only exists while the Widget Library detail is open, so
        // every entry point here no-ops when it's absent (mini-widget contract).

        let aiCatalog = null;          // [{ category, apps:[{id,name}] }]
        let aiWinget = { available: false, version: '' };
        let aiSelected = new Set();    // ids ticked by the user (persisted)
        let aiInstalled = new Set();   // ids winget reports already installed
        let aiSession = null;          // live install progress payload
        let aiRunning = false;
        let aiLoaded = false;
        let aiProgressHooked = false;
        let aiCheckedInstalled = false;
        let aiPresets = {};            // { name: [ids] } — saved app selections
        let aiPresetNaming = false;    // inline "name this preset" input open?
        let aiWingetBusy = false;      // winget bootstrap install in progress

        function isAppInstallerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.appInstaller;
        }

        function aiLoadSelection() {
            const saved = safeParseJSON(localStorage.getItem('appInstallerSelected'), []);
            aiSelected = new Set(Array.isArray(saved) ? saved : []);
        }
        function aiSaveSelection() {
            localStorage.setItem('appInstallerSelected', JSON.stringify([...aiSelected]));
        }

        function aiLoadPresets() {
            const saved = safeParseJSON(localStorage.getItem('appInstallerPresets'), {});
            aiPresets = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
        }
        function aiSavePresetsStore() {
            localStorage.setItem('appInstallerPresets', JSON.stringify(aiPresets));
        }

        // Status for a single app id in the current/last install run.
        function aiResultFor(id) {
            if (!aiSession || !aiSession.results) return null;
            for (let i = aiSession.results.length - 1; i >= 0; i--) {
                if (aiSession.results[i].id === id) return aiSession.results[i];
            }
            return null;
        }

        async function renderAppInstallerPanel() {
            const panel = document.getElementById('app-installer-panel');
            if (!panel) return;
            if (!isAppInstallerEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.appInstallerCatalog) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">App Installer is unavailable.</p>`;
                return;
            }

            if (!aiProgressHooked && window.electronAPI.onAppInstallerProgress) {
                window.electronAPI.onAppInstallerProgress(aiOnProgress);
                aiProgressHooked = true;
            }

            // First open: pull the catalog + winget state, restore the saved
            // selection, and (best-effort) find out what's already installed.
            if (!aiLoaded) {
                aiLoadSelection();
                aiLoadPresets();
                try {
                    const res = await window.electronAPI.appInstallerCatalog();
                    if (res?.ok) { aiCatalog = res.catalog; aiWinget = res.winget || aiWinget; }
                } catch (e) { /* handled by the null-catalog branch below */ }
                try {
                    const st = await window.electronAPI.appInstallerStatus();
                    if (st) { aiRunning = !!st.running; aiSession = st.running || (st.results && st.results.length) ? st : aiSession; }
                } catch (e) { /* no active run */ }
                aiLoaded = true;
            }

            panel.innerHTML = `<div class="ai-root mt-3">${aiBodyHtml()}</div>`;

            // Kick off the installed-check once, in the background, then repaint.
            if (aiWinget.available && !aiCheckedInstalled) {
                aiCheckedInstalled = true;
                aiRefreshInstalled();
            }
        }

        function aiBodyHtml() {
            if (!aiCatalog) {
                return `<div class="ai-empty"><span class="load-ring mb-2"></span><p>Loading catalog…</p></div>`;
            }
            if (!aiWinget.available) {
                return `<div class="ai-empty ai-empty-warn">
                        <i class="fas fa-triangle-exclamation"></i>
                        <p>This installer needs Windows' package manager (<b>winget</b>), which isn't available.</p>
                        <p class="ai-hint">${aiWingetBusy
                            ? 'Downloading and registering winget from Microsoft… this can take a minute.'
                            : 'Install it automatically (no Store needed), or get the App Installer from the Microsoft Store.'}</p>
                        <button type="button" class="ai-btn ai-btn-primary no-drag mt-1" onclick="aiInstallWinget()" ${aiWingetBusy ? 'disabled' : ''}>
                            ${aiWingetBusy ? '<span class="load-ring mr-1.5"></span>Installing winget…' : '<i class="fas fa-download mr-1.5"></i>Install winget automatically'}
                        </button>
                        <button type="button" class="ai-btn no-drag mt-1" onclick="aiOpenWingetStore()" ${aiWingetBusy ? 'disabled' : ''}>
                            <i class="fab fa-microsoft mr-1.5"></i>Get from Store instead
                        </button>
                    </div>`;
            }
            return `
                ${aiRunning || (aiSession && aiSession.results && aiSession.results.length) ? aiProgressHtml() : ''}
                <div id="ai-presets" class="ai-presets">${aiPresetsHtml()}</div>
                <div id="ai-grid" class="ai-grid ${aiRunning ? 'ai-grid-locked' : ''}">${aiGridHtml()}</div>
                <div id="ai-footer" class="ai-footer">${aiFooterHtml()}</div>
                <p class="ai-eula">By installing, you accept each app’s own license terms. Installs run silently via Windows’ winget.</p>`;
        }

        // Presets: saved sets of ticked apps. Click a chip to load that set, save
        // the current selection as a new preset, or export/import to a file so a
        // preset survives a full PC reset (localStorage is wiped on reinstall).
        function aiPresetsHtml() {
            const names = Object.keys(aiPresets);
            const chips = names.map((name) => {
                const count = Array.isArray(aiPresets[name]) ? aiPresets[name].length : 0;
                return `<span class="ai-preset-chip ${aiRunning ? 'ai-preset-locked' : ''}">
                        <button type="button" class="ai-preset-load no-drag" ${aiRunning ? 'disabled' : ''}
                            onclick="aiLoadPreset('${esc(name)}')" title="Load ${esc(name)} (${count} app${count === 1 ? '' : 's'})">
                            <i class="fas fa-folder mr-1.5"></i>${esc(name)}<span class="ai-preset-count">${count}</span>
                        </button>
                        <button type="button" class="ai-preset-x no-drag" ${aiRunning ? 'disabled' : ''}
                            onclick="aiDeletePreset('${esc(name)}')" title="Delete preset"><i class="fas fa-xmark"></i></button>
                    </span>`;
            }).join('');

            const saveControl = aiPresetNaming
                ? `<span class="ai-preset-save-row">
                        <input type="text" id="ai-preset-name" class="ai-preset-input no-drag" maxlength="60" spellcheck="false"
                            placeholder="Preset name…" onkeydown="aiPresetNameKey(event)">
                        <button type="button" class="ai-btn ai-btn-primary no-drag" onclick="aiConfirmSavePreset()"><i class="fas fa-check"></i></button>
                        <button type="button" class="ai-btn no-drag" onclick="aiCancelSavePreset()"><i class="fas fa-xmark"></i></button>
                    </span>`
                : `<button type="button" class="ai-preset-add no-drag" ${aiRunning ? 'disabled' : ''} onclick="aiStartSavePreset()" title="Save the ticked apps as a preset">
                        <i class="fas fa-plus mr-1"></i>Save preset
                    </button>`;

            return `<div class="ai-presets-head">
                    <span class="ai-presets-title"><i class="fas fa-bookmark mr-1.5 text-neutral-500"></i>Presets</span>
                    <span class="ai-presets-io">
                        <button type="button" class="ai-preset-io no-drag" ${aiRunning ? 'disabled' : ''} onclick="aiImportPresets()" title="Import presets from a file"><i class="fas fa-file-import"></i></button>
                        <button type="button" class="ai-preset-io no-drag" ${aiRunning || !names.length ? 'disabled' : ''} onclick="aiExportPresets()" title="Export presets to a file"><i class="fas fa-file-export"></i></button>
                    </span>
                </div>
                <div class="ai-presets-row">
                    ${chips || (aiPresetNaming ? '' : '<span class="ai-presets-empty">No presets yet — tick some apps, then Save preset.</span>')}
                    ${saveControl}
                </div>`;
        }

        function aiGridHtml() {
            return aiCatalog.map((group) => {
                const rows = group.apps.map((app) => {
                    const checked = aiSelected.has(app.id);
                    const isInstalled = aiInstalled.has(app.id);
                    const r = aiResultFor(app.id);
                    let badge = '';
                    if (r) {
                        if (r.status === 'installed') badge = `<i class="fas fa-circle-check ai-badge ai-badge-ok" title="Installed just now"></i>`;
                        else if (r.status === 'already') badge = `<i class="fas fa-circle-check ai-badge ai-badge-have" title="Already installed"></i>`;
                        else if (r.status === 'failed') badge = `<i class="fas fa-circle-xmark ai-badge ai-badge-fail" title="Failed: ${esc(r.reason || 'error')}"></i>`;
                    } else if (isInstalled) {
                        badge = `<i class="fas fa-check ai-badge ai-badge-have" title="Already installed"></i>`;
                    }
                    return `<label class="ai-app ${checked ? 'ai-app-on' : ''} ${aiRunning ? 'ai-app-locked' : ''}" title="${esc(app.id)}">
                            <input type="checkbox" class="ai-check no-drag" ${checked ? 'checked' : ''} ${aiRunning ? 'disabled' : ''}
                                onchange="aiToggle('${esc(app.id)}', this.checked)">
                            <span class="ai-app-name">${esc(app.name)}</span>
                            ${badge}
                        </label>`;
                }).join('');
                const groupIds = group.apps.map((a) => a.id);
                const allOn = groupIds.every((id) => aiSelected.has(id));
                return `<div class="ai-col">
                        <div class="ai-col-head">
                            <span class="ai-col-title">${esc(group.category)}</span>
                            <button type="button" class="ai-col-all no-drag" ${aiRunning ? 'disabled' : ''}
                                onclick="aiToggleCategory('${esc(group.category)}')" title="${allOn ? 'Unselect all' : 'Select all'}">
                                ${allOn ? 'None' : 'All'}
                            </button>
                        </div>
                        <div class="ai-apps">${rows}</div>
                    </div>`;
            }).join('');
        }

        function aiFooterHtml() {
            const n = aiSelected.size;
            if (aiRunning) {
                return `<div class="ai-footer-inner">
                        <span class="ai-footer-count"><span class="load-ring mr-2"></span>Installing…</span>
                        <button type="button" class="ai-btn ai-btn-danger no-drag" onclick="aiCancel()"><i class="fas fa-stop mr-1.5"></i>Stop</button>
                    </div>`;
            }
            return `<div class="ai-footer-inner">
                    <span class="ai-footer-count">${n ? `<b>${n}</b> app${n === 1 ? '' : 's'} selected` : 'Nothing selected yet'}</span>
                    <div class="flex items-center gap-2">
                        ${n ? `<button type="button" class="ai-btn no-drag" onclick="aiClear()">Clear</button>` : ''}
                        <button type="button" class="ai-get no-drag" ${n ? '' : 'disabled'} onclick="aiInstall()">
                            <i class="fas fa-download mr-2"></i>Get ${n ? n + ' app' + (n === 1 ? '' : 's') : 'apps'}
                        </button>
                    </div>
                </div>`;
        }

        function aiProgressHtml() {
            const s = aiSession || { total: 0, done: 0, results: [] };
            const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
            const finished = !aiRunning;
            const items = (s.results || []).map((r) => {
                let icon, cls, label;
                if (r.status === 'installed') { icon = 'fa-circle-check'; cls = 'ai-pr-ok'; label = 'Installed'; }
                else if (r.status === 'already') { icon = 'fa-circle-check'; cls = 'ai-pr-have'; label = 'Already installed'; }
                else { icon = 'fa-circle-xmark'; cls = 'ai-pr-fail'; label = 'Failed' + (r.reason ? ` · ${esc(r.reason)}` : ''); }
                return `<div class="ai-pr-row ${cls}"><i class="fas ${icon}"></i><span class="ai-pr-name">${esc(r.name)}</span><span class="ai-pr-label">${label}</span></div>`;
            }).join('');
            const cur = aiRunning && s.current
                ? `<div class="ai-pr-row ai-pr-active"><span class="load-ring"></span><span class="ai-pr-name">${esc(s.current.name)}</span><span class="ai-pr-label">Installing…</span></div>`
                : '';
            let head;
            if (finished) {
                const ok = (s.results || []).filter((r) => r.status === 'installed').length;
                const have = (s.results || []).filter((r) => r.status === 'already').length;
                const fail = (s.results || []).filter((r) => r.status === 'failed').length;
                const parts = [];
                if (ok) parts.push(`${ok} installed`);
                if (have) parts.push(`${have} already had`);
                if (fail) parts.push(`${fail} failed`);
                head = `<div class="ai-pr-head">
                        <span><i class="fas fa-flag-checkered mr-1.5 text-neutral-400"></i>Done — ${parts.join(' · ') || 'nothing to do'}</span>
                        <button type="button" class="ai-btn no-drag" onclick="aiDismissProgress()"><i class="fas fa-xmark mr-1"></i>Close</button>
                    </div>`;
            } else {
                head = `<div class="ai-pr-head">
                        <span><i class="fas fa-download mr-1.5 text-neutral-400"></i>Installing ${s.done + 1} of ${s.total}</span>
                        <span class="ai-pr-pct">${pct}%</span>
                    </div>`;
            }
            return `<div class="ai-progress">
                    ${head}
                    <div class="ai-pr-bar"><div class="ai-pr-fill" style="width:${pct}%"></div></div>
                    <div class="ai-pr-list">${cur}${items}</div>
                </div>`;
        }

        function aiPaint() {
            const panel = document.getElementById('app-installer-panel');
            if (!panel || !isAppInstallerEnabled()) return;
            const root = panel.querySelector('.ai-root');
            if (root) root.innerHTML = aiBodyHtml();
        }

        // ── Selection ──

        function aiToggle(id, on) {
            if (aiRunning) return;
            if (on) aiSelected.add(id); else aiSelected.delete(id);
            aiSaveSelection();
            aiRepaintChrome();
        }

        function aiToggleCategory(category) {
            if (aiRunning || !aiCatalog) return;
            const group = aiCatalog.find((g) => g.category === category);
            if (!group) return;
            const ids = group.apps.map((a) => a.id);
            const allOn = ids.every((id) => aiSelected.has(id));
            for (const id of ids) { if (allOn) aiSelected.delete(id); else aiSelected.add(id); }
            aiSaveSelection();
            aiRepaintChrome();
        }

        function aiClear() {
            if (aiRunning) return;
            aiSelected.clear();
            aiSaveSelection();
            aiRepaintChrome();
        }

        // Repaint just the grid + footer (leaves any progress block untouched).
        function aiRepaintChrome() {
            const grid = document.getElementById('ai-grid');
            const footer = document.getElementById('ai-footer');
            if (grid) grid.innerHTML = aiGridHtml();
            if (footer) footer.innerHTML = aiFooterHtml();
        }
        function aiPaintPresets() {
            const el = document.getElementById('ai-presets');
            if (el) el.innerHTML = aiPresetsHtml();
        }

        // ── Presets ──

        function aiLoadPreset(name) {
            if (aiRunning) return;
            const ids = aiPresets[name];
            if (!Array.isArray(ids)) return;
            aiSelected = new Set(ids);
            aiSaveSelection();
            aiRepaintChrome();
            aiPaintPresets();
            showToast(`Loaded “${name}” — ${ids.length} app${ids.length === 1 ? '' : 's'} ticked`);
        }

        function aiDeletePreset(name) {
            if (aiRunning) return;
            if (!(name in aiPresets)) return;
            delete aiPresets[name];
            aiSavePresetsStore();
            aiPaintPresets();
            showToast(`Deleted preset “${name}”`);
        }

        function aiStartSavePreset() {
            if (aiRunning) return;
            if (!aiSelected.size) { showToast('Tick some apps first', true); return; }
            aiPresetNaming = true;
            aiPaintPresets();
            const input = document.getElementById('ai-preset-name');
            if (input) input.focus();
        }

        function aiCancelSavePreset() {
            aiPresetNaming = false;
            aiPaintPresets();
        }

        function aiConfirmSavePreset() {
            const input = document.getElementById('ai-preset-name');
            const name = (input ? input.value : '').trim().slice(0, 60);
            if (!name) { showToast('Give the preset a name', true); if (input) input.focus(); return; }
            if (!aiSelected.size) { showToast('Tick some apps first', true); return; }
            const existed = name in aiPresets;
            aiPresets[name] = [...aiSelected];
            aiSavePresetsStore();
            aiPresetNaming = false;
            aiPaintPresets();
            showToast(`${existed ? 'Updated' : 'Saved'} preset “${name}” (${aiSelected.size})`);
        }

        function aiPresetNameKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); aiConfirmSavePreset(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); aiCancelSavePreset(); }
        }

        async function aiExportPresets() {
            if (aiRunning || !window.electronAPI?.appInstallerExportPresets) return;
            if (!Object.keys(aiPresets).length) { showToast('No presets to export', true); return; }
            const res = await window.electronAPI.appInstallerExportPresets(JSON.stringify(aiPresets));
            if (res?.ok) showToast('Presets exported');
            else if (!res?.cancelled) showToast('Export failed', true);
        }

        async function aiImportPresets() {
            if (aiRunning || !window.electronAPI?.appInstallerImportPresets) return;
            const res = await window.electronAPI.appInstallerImportPresets();
            if (res?.ok && res.presets) {
                // Merge imported presets over the current ones (imported wins on a
                // name clash), then persist + repaint.
                aiPresets = { ...aiPresets, ...res.presets };
                aiSavePresetsStore();
                aiPaintPresets();
                const n = Object.keys(res.presets).length;
                showToast(n ? `Imported ${n} preset${n === 1 ? '' : 's'}` : 'No valid presets in that file', !n);
            } else if (res && !res.cancelled) {
                showToast(res.error === 'bad-format' ? 'That file isn’t a presets file' : 'Import failed', true);
            }
        }

        // ── Install run ──

        async function aiInstall() {
            if (aiRunning || !window.electronAPI?.appInstallerInstall) return;
            const ids = [...aiSelected];
            if (!ids.length) return;
            aiRunning = true;
            aiSession = { total: ids.length, done: 0, current: null, results: [] };
            aiPaint();
            showToast(`Installing ${ids.length} app${ids.length === 1 ? '' : 's'}…`);
            try {
                const res = await window.electronAPI.appInstallerInstall(ids);
                if (res && !res.ok) {
                    aiRunning = false;
                    aiPaint();
                    if (res.error === 'winget-missing') showToast('winget is not available', true);
                    else if (res.error === 'nothing-selected') showToast('Nothing selected', true);
                    else if (res.error === 'already-running') showToast('An install is already running', true);
                    else showToast('Could not start install', true);
                }
                // Success path is driven entirely by the progress events below.
            } catch (e) {
                aiRunning = false;
                aiPaint();
                showToast('Install failed to start', true);
            }
        }

        async function aiCancel() {
            if (!window.electronAPI?.appInstallerCancel) return;
            await window.electronAPI.appInstallerCancel();
            showToast('Stopping after the current app…');
        }

        function aiOnProgress(data) {
            if (!data) return;
            aiRunning = !!data.running;
            aiSession = data;
            if (data.finished) {
                const s = data.summary || {};
                const bits = [];
                if (s.installed) bits.push(`${s.installed} installed`);
                if (s.already) bits.push(`${s.already} already had`);
                if (s.failed) bits.push(`${s.failed} failed`);
                showToast(data.cancelled ? 'Install stopped' : `Done — ${bits.join(', ') || 'nothing to do'}`, !!s.failed && !s.installed);
                // Newly installed apps are now "already installed"; drop them from
                // the ticked set and refresh the installed badges.
                for (const r of data.results || []) {
                    if (r.status === 'installed' || r.status === 'already') { aiInstalled.add(r.id); aiSelected.delete(r.id); }
                }
                aiSaveSelection();
                aiCheckedInstalled = true;
                aiRefreshInstalled();
            }
            // Only repaint if our panel is actually on screen.
            if (document.getElementById('app-installer-panel') && isAppInstallerEnabled()) aiPaint();
        }

        function aiDismissProgress() {
            aiSession = null;
            aiPaint();
        }

        async function aiRefreshInstalled() {
            if (!window.electronAPI?.appInstallerInstalled) return;
            try {
                const res = await window.electronAPI.appInstallerInstalled();
                if (res?.ok && Array.isArray(res.installed)) {
                    aiInstalled = new Set(res.installed);
                    // Repaint just the grid so badges show without disturbing anything else.
                    const grid = document.getElementById('ai-grid');
                    if (grid) grid.innerHTML = aiGridHtml();
                }
            } catch (e) { /* badges are best-effort */ }
        }

        async function aiOpenWingetStore() {
            if (!window.electronAPI?.appInstallerOpenWingetStore) return;
            await window.electronAPI.appInstallerOpenWingetStore();
            showToast('Opening the Microsoft Store…');
        }

        // Store-less winget install: main downloads the App Installer package + its
        // dependencies from Microsoft and registers them for this user (no admin).
        // On success winget is live, so flip the panel over to the real catalog.
        async function aiInstallWinget() {
            if (aiWingetBusy || !window.electronAPI?.appInstallerInstallWinget) return;
            aiWingetBusy = true;
            aiPaint();
            showToast('Installing winget from Microsoft…');
            try {
                const res = await window.electronAPI.appInstallerInstallWinget();
                if (res && res.ok && res.winget) {
                    aiWinget = res.winget;
                    showToast(`winget ${res.winget.version || ''} installed`.trim());
                    aiWingetBusy = false;
                    aiPaint();                       // repaint into the real catalog
                    if (aiWinget.available && !aiCheckedInstalled) { aiCheckedInstalled = true; aiRefreshInstalled(); }
                    return;
                }
                if (res && res.error === 'installed-pending') {
                    showToast(res.hint || 'winget installed — restart main to finish.', true);
                } else {
                    showToast((res && res.detail) || 'Could not install winget automatically — try the Store option.', true);
                }
            } catch (e) {
                showToast('winget install failed — try the Store option.', true);
                console.error('winget bootstrap failed', e);
            }
            aiWingetBusy = false;
            aiPaint();
        }
