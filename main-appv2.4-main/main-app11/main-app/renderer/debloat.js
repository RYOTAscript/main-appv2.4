        // ── Windows Debloat mini widget ──
        // Two tabs in one panel:
        //   • Remove Apps — a grid of the preinstalled Store apps actually present
        //     on this PC; tick a few, hit Remove, and they're uninstalled for the
        //     current user one after another (live progress list).
        //   • Tweaks — reversible privacy/UX switches, each a real on/off toggle
        //     read straight from the registry.
        // All the privileged work lives in main/debloat.js; this file is only UI.
        // The panel div exists solely while the Widget Library detail is open, so
        // every entry point no-ops when it's absent (mini-widget contract).

        let dblApps = null;            // [{ category, apps:[{name,label,caution,note}] }]
        let dblTweaks = null;          // [{ category, tweaks:[{id,label,description,restartExplorer}] }]
        let dblPs = { available: false };
        let dblOs = null;              // { build, isWin11, name } — detected edition
        let dblInstalled = new Set();  // package names present on this PC
        let dblSelected = new Set();   // names ticked for removal (persisted)
        let dblTweakState = {};        // id -> bool (applied)
        let dblSession = null;         // live removal progress payload
        let dblRunning = false;
        let dblLoaded = false;
        let dblScanned = false;
        let dblScanDone = false;
        let dblProgressHooked = false;
        let dblTab = 'apps';           // 'apps' | 'tweaks'
        let dblNeedsExplorerRestart = false;
        let dblBusyTweak = null;       // id of a tweak mid-toggle (disables it)

        function isDebloatEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.debloat;
        }

        function dblLoadSelection() {
            const saved = safeParseJSON(localStorage.getItem('debloatSelected'), []);
            dblSelected = new Set(Array.isArray(saved) ? saved : []);
        }
        function dblSaveSelection() {
            localStorage.setItem('debloatSelected', JSON.stringify([...dblSelected]));
        }

        function dblResultFor(name) {
            if (!dblSession || !dblSession.results) return null;
            for (let i = dblSession.results.length - 1; i >= 0; i--) {
                if (dblSession.results[i].name === name) return dblSession.results[i];
            }
            return null;
        }

        async function renderDebloatPanel() {
            const panel = document.getElementById('debloat-panel');
            if (!panel) return;
            if (!isDebloatEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.debloatCatalog) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Debloat is unavailable.</p>`;
                return;
            }

            if (!dblProgressHooked && window.electronAPI.onDebloatProgress) {
                window.electronAPI.onDebloatProgress(dblOnProgress);
                dblProgressHooked = true;
            }

            if (!dblLoaded) {
                dblLoadSelection();
                try {
                    const res = await window.electronAPI.debloatCatalog();
                    if (res?.ok) { dblApps = res.apps; dblTweaks = res.tweaks; dblPs = res.ps || dblPs; dblOs = res.os || null; }
                } catch (e) { /* handled by null-catalog branch */ }
                try {
                    const st = await window.electronAPI.debloatStatus();
                    if (st) { dblRunning = !!st.running; dblSession = (st.running || (st.results && st.results.length)) ? st : dblSession; }
                } catch (e) { /* no active run */ }
                dblLoaded = true;
            }

            panel.innerHTML = `<div class="dbl-root mt-3">${dblBodyHtml()}</div>`;

            // Kick off the (read-only) scans once, in the background, then repaint.
            if (dblPs.available && !dblScanned) {
                dblScanned = true;
                dblScan();
                dblRefreshTweaks();
            }
        }

        function dblBodyHtml() {
            if (!dblApps) {
                return `<div class="dbl-empty"><span class="load-ring mb-2"></span><p>Loading…</p></div>`;
            }
            if (!dblPs.available) {
                return `<div class="dbl-empty dbl-empty-warn">
                        <i class="fas fa-triangle-exclamation"></i>
                        <p>Debloat needs Windows PowerShell, which isn't responding on this PC.</p>
                    </div>`;
            }
            return `
                ${dblTabsHtml()}
                <div class="dbl-tabbody">${dblTab === 'apps' ? dblAppsTabHtml() : dblTweaksTabHtml()}</div>
                <p class="dbl-eula">Changes apply only to what you tick, using Windows' own tools, for your user account only. App removals affect your account; tweaks are reversible from this panel.${dblOs ? ` Tweaks are filtered for <b>${esc(dblOs.name)}</b> — only ones that work on your edition are shown.` : ''}</p>`;
        }

        function dblTabsHtml() {
            return `<div class="dbl-tabs">
                    <button type="button" class="dbl-tab no-drag ${dblTab === 'apps' ? 'dbl-tab-on' : ''}" onclick="dblSwitchTab('apps')">
                        <i class="fas fa-trash-can mr-1.5"></i>Remove Apps
                    </button>
                    <button type="button" class="dbl-tab no-drag ${dblTab === 'tweaks' ? 'dbl-tab-on' : ''}" onclick="dblSwitchTab('tweaks')">
                        <i class="fas fa-sliders mr-1.5"></i>Tweaks
                    </button>
                </div>`;
        }

        // ── Remove Apps tab ──

        function dblAppsTabHtml() {
            const running = dblRunning || (dblSession && dblSession.results && dblSession.results.length);
            return `
                ${running ? dblProgressHtml() : ''}
                <div id="dbl-grid" class="dbl-grid ${dblRunning ? 'dbl-grid-locked' : ''}">${dblGridHtml()}</div>
                <div id="dbl-footer" class="dbl-footer">${dblFooterHtml()}</div>`;
        }

        // Only the apps actually installed on this PC are worth showing — you can't
        // remove what isn't there. Until the scan lands we say so.
        function dblGridHtml() {
            if (!dblScanned || (!dblInstalled.size && !dblScanDone)) {
                return `<div class="dbl-empty"><span class="load-ring mb-2"></span><p>Scanning installed apps…</p></div>`;
            }
            const groups = dblApps
                .map((group) => ({ category: group.category, apps: group.apps.filter((a) => dblInstalled.has(a.name)) }))
                .filter((g) => g.apps.length);
            if (!groups.length) {
                return `<div class="dbl-empty"><i class="fas fa-broom"></i><p>Nothing to clean — none of the known bloat apps are installed. Nice.</p></div>`;
            }
            return groups.map((group) => {
                const rows = group.apps.map((app) => {
                    const checked = dblSelected.has(app.name);
                    const r = dblResultFor(app.name);
                    let badge = '';
                    if (r) {
                        if (r.status === 'removed') badge = `<i class="fas fa-circle-check dbl-badge dbl-badge-ok" title="Removed"></i>`;
                        else if (r.status === 'absent') badge = `<i class="fas fa-circle-minus dbl-badge dbl-badge-have" title="Wasn't installed"></i>`;
                        else if (r.status === 'failed') badge = `<i class="fas fa-circle-xmark dbl-badge dbl-badge-fail" title="Failed: ${esc(r.reason || 'error')}"></i>`;
                    } else if (app.caution) {
                        badge = `<i class="fas fa-triangle-exclamation dbl-badge dbl-badge-warn" title="${esc(app.note || 'You might actually use this')}"></i>`;
                    }
                    return `<label class="dbl-app ${checked ? 'dbl-app-on' : ''} ${dblRunning ? 'dbl-app-locked' : ''}" title="${esc(app.name)}">
                            <input type="checkbox" class="dbl-check no-drag" ${checked ? 'checked' : ''} ${dblRunning ? 'disabled' : ''}
                                onchange="dblToggle('${esc(app.name)}', this.checked)">
                            <span class="dbl-app-name">${esc(app.label)}</span>
                            ${badge}
                        </label>`;
                }).join('');
                const groupNames = group.apps.map((a) => a.name);
                const allOn = groupNames.every((n) => dblSelected.has(n));
                return `<div class="dbl-col">
                        <div class="dbl-col-head">
                            <span class="dbl-col-title">${esc(group.category)}</span>
                            <button type="button" class="dbl-col-all no-drag" ${dblRunning ? 'disabled' : ''}
                                onclick="dblToggleCategory('${esc(group.category)}')" title="${allOn ? 'Unselect all' : 'Select all'}">
                                ${allOn ? 'None' : 'All'}
                            </button>
                        </div>
                        <div class="dbl-apps">${rows}</div>
                    </div>`;
            }).join('');
        }

        function dblFooterHtml() {
            const n = dblSelected.size;
            if (dblRunning) {
                return `<div class="dbl-footer-inner">
                        <span class="dbl-footer-count"><span class="load-ring mr-2"></span>Removing…</span>
                        <button type="button" class="dbl-btn dbl-btn-danger no-drag" onclick="dblCancel()"><i class="fas fa-stop mr-1.5"></i>Stop</button>
                    </div>`;
            }
            const hasInstalled = dblInstalled.size > 0;
            return `<div class="dbl-footer-inner">
                    <span class="dbl-footer-count">${n ? `<b>${n}</b> selected for removal` : 'Nothing selected'}</span>
                    <div class="flex items-center gap-2">
                        ${hasInstalled ? `<button type="button" class="dbl-btn no-drag" onclick="dblSelectSafe()" title="Tick every safe-to-remove app">Select safe</button>` : ''}
                        ${n ? `<button type="button" class="dbl-btn no-drag" onclick="dblClear()">Clear</button>` : ''}
                        <button type="button" class="dbl-remove no-drag" ${n ? '' : 'disabled'} onclick="dblRemove()">
                            <i class="fas fa-trash-can mr-2"></i>Remove ${n ? n + ' app' + (n === 1 ? '' : 's') : 'apps'}
                        </button>
                    </div>
                </div>`;
        }

        function dblProgressHtml() {
            const s = dblSession || { total: 0, done: 0, results: [] };
            const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
            const finished = !dblRunning;
            const items = (s.results || []).map((r) => {
                let icon, cls, label;
                if (r.status === 'removed') { icon = 'fa-circle-check'; cls = 'dbl-pr-ok'; label = 'Removed'; }
                else if (r.status === 'absent') { icon = 'fa-circle-minus'; cls = 'dbl-pr-have'; label = "Wasn't installed"; }
                else { icon = 'fa-circle-xmark'; cls = 'dbl-pr-fail'; label = 'Failed' + (r.reason ? ` · ${esc(r.reason)}` : ''); }
                return `<div class="dbl-pr-row ${cls}"><i class="fas ${icon}"></i><span class="dbl-pr-name">${esc(r.label || r.name)}</span><span class="dbl-pr-label">${label}</span></div>`;
            }).join('');
            const cur = dblRunning && s.current
                ? `<div class="dbl-pr-row dbl-pr-active"><span class="load-ring"></span><span class="dbl-pr-name">${esc(s.current.label || s.current.name)}</span><span class="dbl-pr-label">Removing…</span></div>`
                : '';
            let head;
            if (finished) {
                const ok = (s.results || []).filter((r) => r.status === 'removed').length;
                const have = (s.results || []).filter((r) => r.status === 'absent').length;
                const fail = (s.results || []).filter((r) => r.status === 'failed').length;
                const parts = [];
                if (ok) parts.push(`${ok} removed`);
                if (have) parts.push(`${have} weren't there`);
                if (fail) parts.push(`${fail} failed`);
                head = `<div class="dbl-pr-head">
                        <span><i class="fas fa-flag-checkered mr-1.5 text-neutral-400"></i>Done — ${parts.join(' · ') || 'nothing to do'}</span>
                        <button type="button" class="dbl-btn no-drag" onclick="dblDismissProgress()"><i class="fas fa-xmark mr-1"></i>Close</button>
                    </div>`;
            } else {
                head = `<div class="dbl-pr-head">
                        <span><i class="fas fa-trash-can mr-1.5 text-neutral-400"></i>Removing ${s.done + 1} of ${s.total}</span>
                        <span class="dbl-pr-pct">${pct}%</span>
                    </div>`;
            }
            return `<div class="dbl-progress">
                    ${head}
                    <div class="dbl-pr-bar"><div class="dbl-pr-fill" style="width:${pct}%"></div></div>
                    <div class="dbl-pr-list">${cur}${items}</div>
                </div>`;
        }

        // ── Tweaks tab ──

        function dblTweaksTabHtml() {
            return `<div id="dbl-restart-slot">${dblRestartBarHtml()}</div><div id="dbl-tweaks-body">${dblTweaksGroupsHtml()}</div>`;
        }

        function dblRestartBarHtml() {
            if (!dblNeedsExplorerRestart) return '';
            return `<div class="dbl-restart-bar">
                        <span><i class="fas fa-rotate mr-1.5"></i>Some changes need Explorer to restart to show.</span>
                        <button type="button" class="dbl-btn dbl-btn-primary no-drag" onclick="dblRestartExplorer()"><i class="fas fa-rotate mr-1.5"></i>Restart Explorer</button>
                    </div>`;
        }

        function dblTweaksGroupsHtml() {
            const groups = (dblTweaks || []).map((group) => {
                const rows = group.tweaks.map((tw) => {
                    const on = !!dblTweakState[tw.id];
                    const busy = dblBusyTweak === tw.id;
                    return `<div class="dbl-tweak">
                            <div class="dbl-tweak-text">
                                <span class="dbl-tweak-label">${esc(tw.label)}</span>
                                <span class="dbl-tweak-desc">${esc(tw.description)}</span>
                            </div>
                            <button type="button" class="dbl-switch no-drag ${on ? 'dbl-switch-on' : ''} ${busy ? 'dbl-switch-busy' : ''}"
                                ${busy ? 'disabled' : ''} role="switch" aria-checked="${on}"
                                onclick="dblToggleTweak('${esc(tw.id)}')" title="${on ? 'On — click to undo' : 'Off — click to apply'}">
                                <span class="dbl-switch-knob">${busy ? '<span class="load-ring"></span>' : ''}</span>
                            </button>
                        </div>`;
                }).join('');
                return `<div class="dbl-tweak-group">
                        <div class="dbl-col-head"><span class="dbl-col-title">${esc(group.category)}</span></div>
                        <div class="dbl-tweak-list">${rows}</div>
                    </div>`;
            }).join('');
            return groups || '<div class="dbl-empty"><span class="load-ring"></span></div>';
        }

        // Repaint only the tweak switches + restart bar, never the tabs — so a
        // background refresh or a toggle can't flash the whole panel.
        function dblPaintTweaksBody() {
            const body = document.getElementById('dbl-tweaks-body');
            if (body) body.innerHTML = dblTweaksGroupsHtml();
            const slot = document.getElementById('dbl-restart-slot');
            if (slot) slot.innerHTML = dblRestartBarHtml();
        }

        // ── Paint helpers ──

        function dblPaint() {
            const panel = document.getElementById('debloat-panel');
            if (!panel || !isDebloatEnabled()) return;
            const root = panel.querySelector('.dbl-root');
            if (root) root.innerHTML = dblBodyHtml();
        }
        function dblRepaintChrome() {
            const grid = document.getElementById('dbl-grid');
            const footer = document.getElementById('dbl-footer');
            if (grid) grid.innerHTML = dblGridHtml();
            if (footer) footer.innerHTML = dblFooterHtml();
        }
        function dblSwitchTab(tab) {
            if (dblTab === tab) return;
            dblTab = tab;
            const tb = document.querySelector('.dbl-tabbody');
            if (tb) tb.innerHTML = tab === 'apps' ? dblAppsTabHtml() : dblTweaksTabHtml();
            // Toggle the active class on the existing buttons rather than rebuilding
            // them — re-creating the just-clicked button restarts its CSS transition
            // and reads as a flicker.
            document.querySelectorAll('.dbl-tab').forEach((btn, i) => {
                btn.classList.toggle('dbl-tab-on', (i === 0) === (tab === 'apps'));
            });
        }

        // ── Selection ──

        function dblToggle(name, on) {
            if (dblRunning) return;
            if (on) dblSelected.add(name); else dblSelected.delete(name);
            dblSaveSelection();
            dblRepaintChrome();
        }
        function dblToggleCategory(category) {
            if (dblRunning || !dblApps) return;
            const group = dblApps.find((g) => g.category === category);
            if (!group) return;
            const names = group.apps.filter((a) => dblInstalled.has(a.name)).map((a) => a.name);
            const allOn = names.every((n) => dblSelected.has(n));
            for (const n of names) { if (allOn) dblSelected.delete(n); else dblSelected.add(n); }
            dblSaveSelection();
            dblRepaintChrome();
        }
        function dblClear() {
            if (dblRunning) return;
            dblSelected.clear();
            dblSaveSelection();
            dblRepaintChrome();
        }
        // Tick every installed app that isn't flagged "you might want this".
        function dblSelectSafe() {
            if (dblRunning || !dblApps) return;
            for (const group of dblApps) {
                for (const app of group.apps) {
                    if (dblInstalled.has(app.name) && !app.caution) dblSelected.add(app.name);
                }
            }
            dblSaveSelection();
            dblRepaintChrome();
            showToast(`${dblSelected.size} safe app${dblSelected.size === 1 ? '' : 's'} ticked`);
        }

        // ── Removal run ──

        async function dblRemove() {
            if (dblRunning || !window.electronAPI?.debloatRemove) return;
            const names = [...dblSelected].filter((n) => dblInstalled.has(n));
            if (!names.length) return;
            dblRunning = true;
            dblSession = { total: names.length, done: 0, current: null, results: [] };
            dblPaint();
            showToast(`Removing ${names.length} app${names.length === 1 ? '' : 's'}…`);
            try {
                const res = await window.electronAPI.debloatRemove(names);
                if (res && !res.ok) {
                    dblRunning = false;
                    dblPaint();
                    if (res.error === 'ps-missing') showToast('PowerShell is not available', true);
                    else if (res.error === 'nothing-selected') showToast('Nothing selected', true);
                    else if (res.error === 'already-running') showToast('A removal is already running', true);
                    else showToast('Could not start removal', true);
                }
                // Success path is driven by the progress events below.
            } catch (e) {
                dblRunning = false;
                dblPaint();
                showToast('Removal failed to start', true);
            }
        }

        async function dblCancel() {
            if (!window.electronAPI?.debloatCancel) return;
            await window.electronAPI.debloatCancel();
            showToast('Stopping after the current app…');
        }

        function dblOnProgress(data) {
            if (!data) return;
            dblRunning = !!data.running;
            dblSession = data;
            if (data.finished) {
                const s = data.summary || {};
                const bits = [];
                if (s.removed) bits.push(`${s.removed} removed`);
                if (s.absent) bits.push(`${s.absent} weren't there`);
                if (s.failed) bits.push(`${s.failed} failed`);
                showToast(data.cancelled ? 'Removal stopped' : `Done — ${bits.join(', ') || 'nothing to do'}`, !!s.failed && !s.removed);
                // Removed apps are gone — drop them from the installed set + selection.
                for (const r of data.results || []) {
                    if (r.status === 'removed' || r.status === 'absent') { dblInstalled.delete(r.name); dblSelected.delete(r.name); }
                }
                dblSaveSelection();
            }
            if (document.getElementById('debloat-panel') && isDebloatEnabled()) dblPaint();
        }

        function dblDismissProgress() {
            dblSession = null;
            dblPaint();
        }

        // ── Scans (read-only) ──

        async function dblScan() {
            if (!window.electronAPI?.debloatScanInstalled) return;
            try {
                const res = await window.electronAPI.debloatScanInstalled();
                if (res?.ok && Array.isArray(res.installed)) dblInstalled = new Set(res.installed);
            } catch (e) { /* grid shows the empty state */ }
            dblScanDone = true;
            const grid = document.getElementById('dbl-grid');
            if (grid && dblTab === 'apps') grid.innerHTML = dblGridHtml();
            const footer = document.getElementById('dbl-footer');
            if (footer && dblTab === 'apps') footer.innerHTML = dblFooterHtml();
        }

        async function dblRefreshTweaks() {
            if (!window.electronAPI?.debloatReadTweaks) return;
            try {
                const state = await window.electronAPI.debloatReadTweaks();
                if (state && typeof state === 'object') dblTweakState = state;
            } catch (e) { /* toggles fall back to off */ }
            if (dblTab === 'tweaks') dblPaintTweaksBody();
        }

        // ── Tweak toggle ──

        async function dblToggleTweak(id) {
            if (dblBusyTweak || !window.electronAPI?.debloatSetTweak) return;
            const want = !dblTweakState[id];
            dblBusyTweak = id;
            if (dblTab === 'tweaks') dblPaintTweaksBody();
            try {
                const res = await window.electronAPI.debloatSetTweak(id, want);
                if (res && res.ok) {
                    dblTweakState[id] = typeof res.applied === 'boolean' ? res.applied : want;
                    if (res.restartExplorer) dblNeedsExplorerRestart = true;
                    showToast(dblTweakState[id] ? 'Applied' : 'Reverted');
                } else {
                    showToast('Could not change that setting', true);
                }
            } catch (e) {
                showToast('That setting failed to change', true);
            } finally {
                dblBusyTweak = null;
                if (dblTab === 'tweaks') dblPaintTweaksBody();
            }
        }

        async function dblRestartExplorer() {
            if (!window.electronAPI?.debloatRestartExplorer) return;
            showToast('Restarting Explorer…');
            try { await window.electronAPI.debloatRestartExplorer(); } catch (e) { /* Explorer relaunches itself */ }
            dblNeedsExplorerRestart = false;
            if (dblTab === 'tweaks') dblPaintTweaksBody();
        }
