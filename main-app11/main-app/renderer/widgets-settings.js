        const WIDGET_TRANSITION_MS = 280; // keep in sync with .widget-card's transition duration

        // Fades + shrinks a widget out, THEN (after the transition finishes) actually
        // removes it from the grid flow. Cancels cleanly if animateWidgetIn() is called
        // on the same element before this finishes (rapid toggling).
        function animateWidgetOut(el) {
            if (el._widgetShowRAF) {
                cancelAnimationFrame(el._widgetShowRAF);
                el._widgetShowRAF = null;
            }
            el.dataset.widgetHiding = 'true';
            el.style.transition = '';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.95)';

            if (el._widgetHideTimeout) clearTimeout(el._widgetHideTimeout);
            el._widgetHideTimeout = setTimeout(() => {
                el.classList.add('hidden-widget');
                el.style.opacity = '';
                el.style.transform = '';
                delete el.dataset.widgetHiding;
                el._widgetHideTimeout = null;
            }, WIDGET_TRANSITION_MS);
        }

        // Brings a widget back into the grid and fades + grows it into place.
        function animateWidgetIn(el) {
            if (el._widgetHideTimeout) {
                clearTimeout(el._widgetHideTimeout);
                el._widgetHideTimeout = null;
            }
            delete el.dataset.widgetHiding;
            el.classList.remove('hidden-widget');

            // Snap to the "about to enter" state with no transition, then let it
            // transition in on the next frame (same technique used by the lyrics
            // conveyor) -- otherwise the browser has nothing to animate FROM.
            el.style.transition = 'none';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.95)';
            el._widgetShowRAF = requestAnimationFrame(() => {
                el.style.transition = '';
                el.style.opacity = '1';
                el.style.transform = 'scale(1)';
                el._widgetShowRAF = null;
            });
        }

        let gridColsTimeout = null;

        function computeWidgetColClass() {
            const prefs = safeParseJSON(localStorage.getItem('widgetPrefs'), { notes: true, performance: true, spotify: true });
            const visible = [prefs.notes, prefs.performance, prefs.spotify].filter(Boolean).length;
            return visible === 1 ? 'grid-cols-1' : visible === 2 ? 'grid-cols-2' : 'grid-cols-3';
        }

        // skipAnimation is used only for the very first render on page load, so widgets
        // appear in their correct saved state immediately rather than animating in.
        function applyWidgetPrefs(skipAnimation = false) {
            const prefs = safeParseJSON(localStorage.getItem('widgetPrefs'), { notes: true, performance: true, spotify: true });
            const widgetMap = {
                notes: document.getElementById('widget-notes'),
                performance: document.getElementById('widget-performance'),
                spotify: document.getElementById('widget-spotify')
            };

            document.getElementById('toggle-notes').checked = prefs.notes;
            document.getElementById('toggle-performance').checked = prefs.performance;
            document.getElementById('toggle-spotify').checked = prefs.spotify;

            const visible = [prefs.notes, prefs.performance, prefs.spotify].filter(Boolean).length;
            const row = document.getElementById('widgets-row');
            const colClass = visible === 1 ? 'grid-cols-1' : visible === 2 ? 'grid-cols-2' : 'grid-cols-3';
            // Update only the column count — don't overwrite the full className since that
            // would wipe the widgets-animate class that enables transitions post-startup.
            function setGridCols(colCls) {
                row.classList.remove('grid-cols-1', 'grid-cols-2', 'grid-cols-3');
                row.classList.add(colCls);
                // Ensure base grid classes are always present (safe to re-add if already there).
                row.classList.add('grid', 'gap-5', 'px-8', 'mt-10');
            }

            if (skipAnimation) {
                for (const [key, el] of Object.entries(widgetMap)) {
                    if (el) el.classList.toggle('hidden-widget', !prefs[key]);
                }
                setGridCols(colClass);
                // Enable transitions one frame later — the layout is now settled so any
                // future toggle will animate, but the startup render itself never did.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        row.classList.add('widgets-animate');
                    });
                });
                return;
            }

            const toHide = [];
            const toShow = [];
            for (const [key, el] of Object.entries(widgetMap)) {
                if (!el) continue;
                const wasVisible = !el.classList.contains('hidden-widget') && el.dataset.widgetHiding !== 'true';
                const willBeVisible = !!prefs[key];
                if (wasVisible && !willBeVisible) toHide.push(el);
                else if (!wasVisible && willBeVisible) toShow.push(el);
            }

            // Toggling two widgets within one transition window used to schedule two
            // independent timeouts, each carrying the column count computed at ITS
            // own call time — the earlier (now-stale) one could apply after the later
            // toggle, briefly showing the wrong column count. Cancelling any pending
            // timeout here and recomputing the column class only when it actually
            // fires (from live prefs, not a snapshot) collapses rapid toggles into a
            // single correct transition.
            if (gridColsTimeout) {
                clearTimeout(gridColsTimeout);
                gridColsTimeout = null;
            }

            if (toHide.length === 0) {
                setGridCols(colClass);
                toShow.forEach(animateWidgetIn);
            } else {
                toHide.forEach(animateWidgetOut);
                gridColsTimeout = setTimeout(() => {
                    gridColsTimeout = null;
                    setGridCols(computeWidgetColClass());
                    toShow.forEach(animateWidgetIn);
                }, WIDGET_TRANSITION_MS);
            }
        }

        function saveWidgetPrefs() {
            const prefs = {
                notes: document.getElementById('toggle-notes').checked,
                performance: document.getElementById('toggle-performance').checked,
                spotify: document.getElementById('toggle-spotify').checked
            };
            localStorage.setItem('widgetPrefs', JSON.stringify(prefs));
            applyWidgetPrefs();
            if (prefs.performance) startPerformanceMonitor();
            else stopPerformanceMonitor();
            scheduleSettingsSave();
        }

        // Builds the "Mini Widgets" Settings rows from the MINI_WIDGETS registry, so
        // adding a future widget there doesn't require touching this rendering code.
        function renderMiniWidgetsSettings() {
            const container = document.getElementById('mini-widgets-settings-list');
            if (!container) return;
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            container.innerHTML = MINI_WIDGETS.map(w => `
                <div class="border border-white/10 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-4 mb-2">
                        <label class="flex items-center gap-3 cursor-pointer">
                            <span class="ios-toggle"><input type="checkbox" id="toggle-widget-${w.id}" class="ios-toggle-input" ${prefs[w.id] ? 'checked' : ''} onchange="saveMiniWidgetPrefs()"><span class="ios-toggle-track"></span></span>
                            <span><i class="fas ${w.icon} mr-1.5 text-neutral-500"></i>${w.label}</span>
                        </label>
                        ${w.defaultHotkey ? `<button type="button" id="${getHotkeyButtonId(w.id)}" class="hotkey-bind no-drag"
                            onclick="startHotkeyBind('${w.id}')"></button>` : ''}
                    </div>
                    <div id="mini-widget-body-${w.id}" class="${prefs[w.id] ? '' : 'hidden'}">
                        <p class="text-xs text-neutral-600">${w.description}</p>
                        ${w.panelId ? `<div id="${w.panelId}"></div>` : ''}
                    </div>
                </div>
            `).join('');
            updateHotkeyDisplays();
            if (typeof renderMacrosPanel === 'function') renderMacrosPanel();
            if (typeof renderClipboardPanel === 'function') renderClipboardPanel();
            if (typeof renderSpotifyEnhancedPanel === 'function') renderSpotifyEnhancedPanel();
            if (typeof renderScreenResolutionPanel === 'function') renderScreenResolutionPanel();
        }

        function saveMiniWidgetPrefs() {
            const prefs = {};
            for (const w of MINI_WIDGETS) {
                const cb = document.getElementById(`toggle-widget-${w.id}`);
                prefs[w.id] = !!(cb && cb.checked);
                document.getElementById(`mini-widget-body-${w.id}`)?.classList.toggle('hidden', !prefs[w.id]);
            }
            localStorage.setItem('miniWidgetPrefs', JSON.stringify(prefs));
            applyMiniWidgetPrefs();
            scheduleSettingsSave();
        }

        // Turns the system-wide mic-mute overlay (a separate always-on-top window,
        // drawn by main.js so it stays visible above every other app, not just this
        // one) on or off based on the saved widget preference.
        async function applyMiniWidgetPrefs() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            if (window.electronAPI?.setMicMuteOverlayEnabled) {
                await window.electronAPI.setMicMuteOverlayEnabled(!!prefs.micMute);
            }
            if (window.electronAPI?.macrosSetEnabled) {
                await window.electronAPI.macrosSetEnabled(!!prefs.macros);
                if (typeof renderMacrosPanel === 'function') renderMacrosPanel();
            }
            if (window.electronAPI?.clipboardSetEnabled) {
                await window.electronAPI.clipboardSetEnabled(!!prefs.clipboard);
                if (typeof renderClipboardPanel === 'function') renderClipboardPanel();
            }
            // Spotify Enhanced has no main-process enable toggle (it's purely a
            // renderer feature layered on the existing Spotify integration) — just
            // show/hide the player's heart button and refresh its panel.
            if (typeof applySpotifyEnhancedEnabled === 'function') {
                applySpotifyEnhancedEnabled(!!prefs.spotifyEnhanced);
            }
            // Screen Resolution Manager is renderer-only too — (re)load the panel so
            // toggling it on immediately populates the monitor list.
            if (typeof renderScreenResolutionPanel === 'function') {
                renderScreenResolutionPanel();
            }
        }

        function saveLyricsPrefs() {
            const enabled = document.getElementById('toggle-lyrics').checked;
            localStorage.setItem('lyricsEnabled', enabled ? 'true' : 'false');
            const panel = document.getElementById('spotify-lyrics-panel');
            if (panel) {
                panel.style.display = enabled ? 'flex' : 'none';
            }
            scheduleSettingsSave();
        }

        function applyLyricsPrefs() {
            const enabled = localStorage.getItem('lyricsEnabled') !== 'false';
            const checkbox = document.getElementById('toggle-lyrics');
            if (checkbox) checkbox.checked = enabled;
            const panel = document.getElementById('spotify-lyrics-panel');
            if (panel) {
                panel.style.display = enabled ? 'flex' : 'none';
            }
        }

        // Initialize lyrics panel with placeholder (defensive — normally the static
        // markup already has #spotify-lyrics-window nested inside, so this is a no-op)
        function initLyricsPanel() {
            const panel = document.getElementById('spotify-lyrics-lines');
            if (panel && !panel.querySelector('#spotify-lyrics-window')) {
                panel.innerHTML = '<div id="spotify-lyrics-window"></div>';
            }
        }

        function applyAppearance() {
            const intensity = localStorage.getItem('glowIntensity') || 'medium';
            document.getElementById('glow-intensity').value = intensity;
            const map = {
                low: { strength: 0.06, spread: '24px' },
                medium: { strength: 0.12, spread: '40px' },
                high: { strength: 0.22, spread: '60px' }
            };
            const v = map[intensity] || map.medium;
            document.documentElement.style.setProperty('--glow-strength', v.strength);
            document.documentElement.style.setProperty('--glow-spread', v.spread);
        }

        function saveAppearance() {
            localStorage.setItem('glowIntensity', document.getElementById('glow-intensity').value);
            applyAppearance();
            scheduleSettingsSave();
        }



        function filterSettings(query) {
            const q = (query || '').trim().toLowerCase();
            const panel = document.querySelector('#settings-modal .settings-panel');
            const sections = panel.querySelectorAll(':scope > .mb-10');
            let anyVisible = false;
            sections.forEach(sec => {
                const match = !q || sec.textContent.toLowerCase().includes(q);
                sec.classList.toggle('hidden', !match);
                if (match) anyVisible = true;
            });
            document.getElementById('settings-search-empty').classList.toggle('hidden', anyVisible);
        }

        async function openSettings() {
            renderSettingsApps();
            applyWidgetPrefs();
            applyAppearance();
            renderMiniWidgetsSettings();

            if (window.electronAPI?.getAutoStart) {
                const enabled = await window.electronAPI.getAutoStart();
                document.getElementById('autostart').checked = enabled;
            }
            loadSpotifyPrefs();
            loadSpotifyTimerPref();
            loadSpotifyConfig();
            loadSpotifyAuthStatus();
            loadDiskSpeed();
            loadLyricsAnticipateDelay();
            loadVisualizerPref();
            loadSpotifyExtrasCollapsed();
            refreshSleepTimerUI();
            loadFpsDisplayMode();
            loadClockFormat();
            loadWeatherUnit();
            updateHotkeyDisplays();
            // Awaited before the modal is shown — otherwise a fast click on the
            // close-windows-startup checkbox or the display-monitor dropdown races
            // this IPC round-trip and gets silently reverted when it resolves.
            await Promise.all([loadCloseWindowsStartup(), loadDisplayMonitorSetting()]);
            markSettingsSaved();
            document.getElementById('settings-search').value = '';
            filterSettings('');
            document.getElementById('settings-modal').classList.remove('hidden');
        }

        function closeSettings() {
            clearTimeout(settingsSaveTimer);
            persistSettings();
            document.getElementById('settings-modal').classList.add('hidden');
        }

        function deleteApp(i) {
            pinnedApps.splice(i, 1);
            renderSettingsApps();
            renderApps();
            scheduleSettingsSave();
            showToast('App removed');
        }

        function addNewApp() {
            if (pinnedApps.length >= 6) return;
            pinnedApps.push({
                name: 'New App',
                path: '',
                icon: 'main.ico'
            });
            renderSettingsApps();
            renderApps();
            scheduleSettingsSave();
            showToast('New app added');
        }

        function renderSettingsApps() {
            const container = document.getElementById('settings-apps');
            let html = pinnedApps.map((app, i) => `
                <div class="border border-neutral-800 rounded-2xl p-4 bg-neutral-950/50 relative" draggable="true" data-index="${i}"
                     ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="drop(event)">
                    <button onclick="deleteApp(${i})" class="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-xs bg-neutral-800/30 hover:bg-red-800/50 border border-neutral-700/50 hover:border-red-700/50 text-neutral-400 hover:text-red-400 rounded-lg transition-colors no-drag" title="Delete app">✕</button>
                    <div class="flex justify-center mb-3">
                        <img src="${esc(getIconPath(app.icon))}" class="w-14 h-14 object-contain rounded-xl"
                             onerror="this.outerHTML='<div class=\\'w-14 h-14 bg-neutral-800 rounded-xl flex items-center justify-center text-2xl text-neutral-500\\'>?</div>'">
                    </div>
                    <input type="text" value="${esc(app.name)}" onchange="updateAppName(${i}, this.value)"
                           class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm mb-2 focus:outline-none focus:border-neutral-600">
                    <input type="text" value="${esc(app.path)}" onchange="updateAppPath(${i}, this.value)"
                           class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs mb-3 focus:outline-none focus:border-neutral-600">
                    <button onclick="changeIcon(${i})" class="text-xs w-full py-2 border border-neutral-700 rounded-xl hover:bg-neutral-800 transition-colors">Change Icon</button>
                </div>
            `).join('');

            if (pinnedApps.length < 6) {
                html += `
                <div class="border border-neutral-700 border-dashed rounded-2xl p-4 bg-neutral-950/30 flex items-center justify-center cursor-pointer hover:bg-neutral-900/40 transition-colors" onclick="addNewApp()">
                    <div class="text-center">
                        <div class="text-3xl text-neutral-600 mb-2">+</div>
                        <p class="text-xs text-neutral-500">Add App</p>
                    </div>
                </div>
                `;
            }

            container.innerHTML = html;
        }

        function dragStart(e) { draggedIndex = parseInt(e.currentTarget.dataset.index, 10); }
        function dragOver(e) { e.preventDefault(); }
        function drop(e) {
            e.preventDefault();
            const targetIndex = parseInt(e.currentTarget.dataset.index, 10);
            if (draggedIndex === null || draggedIndex === targetIndex) { draggedIndex = null; return; }
            const [moved] = pinnedApps.splice(draggedIndex, 1);
            pinnedApps.splice(targetIndex, 0, moved);
            draggedIndex = null;
            renderSettingsApps();
            renderApps();
            scheduleSettingsSave();
        }

        function updateAppName(i, val) { pinnedApps[i].name = val; scheduleSettingsSave(); }
        function updateAppPath(i, val) { pinnedApps[i].path = val; scheduleSettingsSave(); }

        async function changeIcon(i) {
            if (!window.electronAPI?.selectIcon) {
                showToast('Icon picker unavailable', true);
                return;
            }
            const selectedFile = await window.electronAPI.selectIcon();
            if (selectedFile) {
                pinnedApps[i].icon = selectedFile;
                renderSettingsApps();
                renderApps();
                scheduleSettingsSave();
            }
        }

        async function toggleAutoStart(enabled) {
            const checkbox = document.getElementById('autostart');
            let success = true;
            if (window.electronAPI?.setAutoStart) {
                const result = await window.electronAPI.setAutoStart(enabled);
                success = !!result?.success;
            }
            if (!success) {
                // The OS rejected the change (e.g. restricted permissions, portable
                // install) — revert the checkbox instead of showing a setting that
                // silently isn't actually in effect.
                if (checkbox) checkbox.checked = !enabled;
                showToast('Could not change autostart — check app permissions', true);
                return;
            }
            scheduleSettingsSave();
            const cwLabel = document.getElementById('close-windows-startup-label');
            if (cwLabel) {
                if (enabled) {
                    cwLabel.classList.add('visible');
                } else {
                    cwLabel.classList.remove('visible');
                    const cb = document.getElementById('close-windows-startup');
                    if (cb && cb.checked) {
                        cb.checked = false;
                        toggleCloseWindowsStartup(false);
                    }
                }
            }
        }

        async function toggleCloseWindowsStartup(enabled) {
            if (window.electronAPI) await window.electronAPI.setCloseWindowsStartup(enabled);
            scheduleSettingsSave();
        }

        async function loadCloseWindowsStartup() {
            const enabled = await window.electronAPI.getCloseWindowsStartup();
            const cb = document.getElementById('close-windows-startup');
            if (cb) cb.checked = enabled;
            const label = document.getElementById('close-windows-startup-label');
            const autostartCb = document.getElementById('autostart');
            if (label) {
                label.classList.toggle('visible', !!(autostartCb && autostartCb.checked));
            }
        }

        function exportSettings() {
            const data = {
                pinnedApps,
                hotkeys,
                widgetPrefs: safeParseJSON(localStorage.getItem('widgetPrefs'), {}),
                miniWidgetPrefs: safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {}),
                glowIntensity: localStorage.getItem('glowIntensity') || 'medium',
                spotifyAutoPlay: localStorage.getItem('spotifyAutoPlay') === 'true',
                spotifyAutoPlayDelay: localStorage.getItem('spotifyAutoPlayDelay') || '2800',
                lyricsAnticipateMs: localStorage.getItem('lyricsAnticipateMs') || String(DEFAULT_LYRICS_ANTICIPATE_MS),
                fpsDisplayMode: localStorage.getItem('fpsDisplayMode') || 'sidepanel',
                screenResFavourites: safeParseJSON(localStorage.getItem('screenResFavourites'), {}),
                version: APP_VERSION
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'main-settings-backup.json';
            a.click();
            // Release the blob once the download has been handed off — otherwise the
            // object URL (and its buffer) stays alive for the whole session.
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }

        function importSettings() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = e => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = async ev => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (data.pinnedApps) {
                            pinnedApps = data.pinnedApps;
                            localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
                        }
                        if (data.widgetPrefs) localStorage.setItem('widgetPrefs', JSON.stringify(data.widgetPrefs));
                        if (data.miniWidgetPrefs) {
                            localStorage.setItem('miniWidgetPrefs', JSON.stringify(data.miniWidgetPrefs));
                            renderMiniWidgetsSettings();
                            await applyMiniWidgetPrefs();
                        }
                        if (data.glowIntensity) localStorage.setItem('glowIntensity', data.glowIntensity);
                        if (data.hotkeys) {
                            hotkeys = data.hotkeys;
                            localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
                            await applyFocusHotkey(hotkeys.focus);
                            updateHotkeyDisplays();
                            await sendSpotifyHotkeysToMain();
                            await sendMicMuteHotkeyToMain();
                        }
                        if (typeof data.spotifyAutoPlay === 'boolean') {
                            localStorage.setItem('spotifyAutoPlay', data.spotifyAutoPlay ? 'true' : 'false');
                            loadSpotifyPrefs();
                        }
                        if (data.spotifyAutoPlayDelay) {
                            localStorage.setItem('spotifyAutoPlayDelay', String(data.spotifyAutoPlayDelay));
                            loadSpotifyPrefs();
                        }
                        if (data.lyricsAnticipateMs) {
                            localStorage.setItem('lyricsAnticipateMs', String(data.lyricsAnticipateMs));
                            loadLyricsAnticipateDelay();
                        }
                        if (data.fpsDisplayMode) {
                            localStorage.setItem('fpsDisplayMode', data.fpsDisplayMode);
                            loadFpsDisplayMode();
                        }
                        if (data.screenResFavourites) {
                            localStorage.setItem('screenResFavourites', JSON.stringify(data.screenResFavourites));
                        }
                        applyWidgetPrefs();
                        applyAppearance();
                        renderApps();
                        markSettingsSaved();
                        showToast('Settings imported');
                    } catch {
                        showToast('Invalid backup file', true);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        }

        function startTyping() {
            const placeholder = document.getElementById('placeholder');
            const notes = document.getElementById('notes');
            placeholder.style.opacity = '0';
            notes.focus();
        }

        function updateNotesPlaceholder() {
            const placeholder = document.getElementById('placeholder');
            const notes = document.getElementById('notes');
            if (!placeholder || !notes) return;
            if (notes.value.trim() === '') {
                placeholder.style.opacity = notes === document.activeElement ? '0' : '1';
            } else {
                placeholder.style.opacity = '0';
            }
        }

