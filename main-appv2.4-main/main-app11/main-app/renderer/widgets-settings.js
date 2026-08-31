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

            // When Spotify is the only visible main widget, the player spans the full
            // width and there's room to the right of the vinyl — grow the Enhanced strip
            // into it (see .spotify-solo in main.css).
            if (widgetMap.spotify) {
                widgetMap.spotify.classList.toggle('spotify-solo', !!(prefs.spotify && !prefs.notes && !prefs.performance));
                // The layout mode may have just flipped (compact ⇄ solo); re-apply the
                // saved draggable-panel position for whichever mode is now active.
                if (typeof applyEwPosition === 'function') applyEwPosition();
            }

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

        // The "Mini Widgets" Settings section is now a summary of the Widget
        // Library (renderer/widget-library.js): enabled/favourite counts, quick
        // chips, and a button into the full library. All per-widget toggles,
        // hotkeys and config panels live in the library's detail view. The full
        // widget names are rendered here (as chips) so the Settings search box
        // still finds e.g. "bluetooth" or "crosshair".
        function renderMiniWidgetsSettings() {
            const container = document.getElementById('mini-widgets-settings-list');
            if (!container) return;
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            const favs = typeof getWidgetFavs === 'function' ? getWidgetFavs() : [];
            const shown = MINI_WIDGETS
                .filter(w => prefs[w.id] || favs.includes(w.id))
                .sort((a, b) => {
                    const favA = favs.includes(a.id) ? 1 : 0;
                    const favB = favs.includes(b.id) ? 1 : 0;
                    if (favA !== favB) return favB - favA;
                    return a.label.localeCompare(b.label);
                });
            const enabledCount = MINI_WIDGETS.filter(w => prefs[w.id]).length;
            const chips = shown.length ? shown.map(w => `
                <button type="button" class="mini-widget-chip no-drag${prefs[w.id] ? '' : ' chip-disabled'}"
                    onclick="openWidgetLibrary(${jsAttr(w.id)})" title="${esc(w.description)}">
                    <i class="${w.iconStyle || 'fas'} ${w.icon} text-[10px]"></i>
                    <span>${esc(w.label)}</span>
                    ${favs.includes(w.id) ? '<i class="fas fa-star text-[8px] mini-widget-chip-star"></i>' : ''}
                </button>
            `).join('') : '<p class="text-xs text-neutral-600">No widgets enabled yet.</p>';

            container.innerHTML = `
                <div class="border border-white/10 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-4 mb-3">
                        <p class="text-xs text-neutral-500">${enabledCount} of ${MINI_WIDGETS.length} widgets enabled${favs.length ? ` · ${favs.length} favourite${favs.length === 1 ? '' : 's'}` : ''}</p>
                        <button type="button" onclick="openWidgetLibrary()"
                            class="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs transition-colors no-drag">
                            <i class="fas fa-shapes mr-1.5"></i>Open Widget Library</button>
                    </div>
                    <div class="flex gap-2 flex-wrap">${chips}</div>
                </div>`;
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
            if (window.electronAPI?.controllerMacrosSetEnabled) {
                await window.electronAPI.controllerMacrosSetEnabled(!!prefs.controllerMacros);
                if (typeof renderControllerMacrosPanel === 'function') renderControllerMacrosPanel();
            }
            if (window.electronAPI?.autoClickerSetEnabled) {
                await window.electronAPI.autoClickerSetEnabled(!!prefs.autoClicker);
                if (typeof renderAutoClickerPanel === 'function') renderAutoClickerPanel();
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
            // Full Screen Lyrics is renderer-only — show/hide the player's full-screen
            // button (which also respects whether the Lyrics display is on), close the
            // stage if it was turned off while open, and refresh its config panel.
            if (typeof applyFullscreenLyricsEnabled === 'function') {
                applyFullscreenLyricsEnabled(!!prefs.fullscreenLyrics);
            }
            // Screen Resolution Manager is renderer-only too — (re)load the panel so
            // toggling it on immediately populates the monitor list.
            if (typeof renderScreenResolutionPanel === 'function') {
                renderScreenResolutionPanel();
            }
            // Bluetooth Manager: start/stop its auto-refresh with the toggle, and
            // load the device list immediately when turned on.
            if (typeof applyBluetoothEnabled === 'function') {
                applyBluetoothEnabled(!!prefs.bluetooth);
            }
            // Translucent Taskbar: push the saved look to the taskbar (and start the
            // enforcement loop) when on; restore the default taskbar when off.
            if (typeof applyTaskbarEnabled === 'function') {
                applyTaskbarEnabled(!!prefs.taskbar);
            }
            // Claude Limit Auto-Continue: start/stop its clipboard watch + resume any
            // armed schedule with the toggle, and (re)render its panel.
            if (typeof applyClaudeLimitEnabled === 'function') {
                applyClaudeLimitEnabled(!!prefs.claudeLimit);
            }
            if (typeof renderClaudeLimitPanel === 'function') renderClaudeLimitPanel();
            // Crosshair: show/hide the overlay window (main process) to match the
            // toggle, and (re)render its settings panel.
            if (typeof applyCrosshairEnabled === 'function') {
                applyCrosshairEnabled();
            }
            // Weather Enhanced is renderer-only — (re)render the panel so toggling
            // it on immediately loads current conditions + forecast.
            if (typeof renderWeatherEnhancedPanel === 'function') {
                renderWeatherEnhancedPanel();
            }
            // Countdown Timer is renderer-only — refresh its panel and the header
            // readout (which hides itself when the widget is disabled).
            if (typeof renderTimerPanel === 'function') renderTimerPanel();
            if (typeof updateTimerIndicator === 'function') updateTimerIndicator();
            // Quick Notes Enhanced: swap the Quick Notes card between the basic
            // textarea and the multi-note editor, and refresh its panel.
            if (typeof applyNotesEnhancedEnabled === 'function') {
                applyNotesEnhancedEnabled(!!prefs.notesEnhanced);
            }
            if (typeof renderNotesEnhancedPanel === 'function') renderNotesEnhancedPanel();
            // Quick Launch Enhanced: show/hide folder + profile controls, start/stop
            // the running-app poll, and refresh its panel.
            if (typeof applyQuickLaunchEnhancedEnabled === 'function') {
                applyQuickLaunchEnhancedEnabled(!!prefs.launchEnhanced);
            }
            if (typeof renderQuickLaunchEnhancedPanel === 'function') renderQuickLaunchEnhancedPanel();
            // Game Mode: start/stop the foreground-window watcher in the main
            // process, then refresh its panel.
            if (typeof applyGameModeEnabled === 'function') {
                await applyGameModeEnabled(!!prefs.gameMode);
            }
            // Volume Mixer: start/stop the Core Audio helper and its hotkeys, then
            // refresh the mixer panel.
            if (typeof applyVolumeMixerEnabled === 'function') {
                await applyVolumeMixerEnabled(!!prefs.volumeMixer);
            }
            // Discord Rich Presence: connect/disconnect the IPC pipe to Discord,
            // then refresh its panel + live preview.
            if (typeof applyDiscordRpcEnabled === 'function') {
                await applyDiscordRpcEnabled(!!prefs.discordRpc);
            }
            // Voice Assistant: start/stop the speech host + hotkey in the main
            // process, then hand it the current vocabulary (pinned apps, enabled
            // widgets, macros) so the recogniser's grammar knows the user's own
            // names, and refresh its panel.
            if (typeof applyVoiceAssistantEnabled === 'function') {
                await applyVoiceAssistantEnabled(!!prefs.voiceAssistant);
            }
            if (typeof renderVoiceAssistantPanel === 'function') renderVoiceAssistantPanel();
            // ValClips Quality is renderer-only (its engine lives in the main
            // process but toggles nothing there) — just refresh its panel so
            // enabling it immediately paints the engine status + drop zone.
            if (typeof renderValclipsPanel === 'function') renderValclipsPanel();
            // Dashboard Mini Widgets strip mirrors the favourites.
            if (typeof renderMiniWidgetsStrip === 'function') {
                renderMiniWidgetsStrip();
            }
        }

        function saveLyricsPrefs() {
            const enabled = document.getElementById('toggle-lyrics').checked;
            localStorage.setItem('lyricsEnabled', enabled ? 'true' : 'false');
            const panel = document.getElementById('spotify-lyrics-panel');
            if (panel) {
                panel.style.display = enabled ? 'flex' : 'none';
            }
            // The Full Screen Lyrics button only makes sense while lyrics are shown —
            // and if lyrics were just turned off, drop out of the stage if it's open.
            if (typeof updateFullscreenLyricsBtn === 'function') updateFullscreenLyricsBtn();
            if (!enabled && typeof isFullscreenLyricsOpen === 'function' && isFullscreenLyricsOpen()) {
                closeFullscreenLyrics();
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
            if (typeof updateFullscreenLyricsBtn === 'function') updateFullscreenLyricsBtn();
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
            // Group headers only make sense over the full, ordered list — while a
            // search is active the surviving sections stand on their own.
            panel.querySelectorAll(':scope > .settings-group-label').forEach(label => {
                label.classList.toggle('hidden', !!q);
            });
            document.getElementById('settings-search-empty').classList.toggle('hidden', anyVisible);
        }

        async function openSettings() {
            renderSettingsApps();
            applyWidgetPrefs();
            applyAppearance();
            renderMiniWidgetsSettings();
            renderBackgroundSettings();
            if (typeof loadAccountInfo === 'function') loadAccountInfo();
            if (typeof loadUpdatesInfo === 'function') loadUpdatesInfo();

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
            loadParallaxPref();
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
            // Stagger the section entrance cascade (animation itself is in main.css).
            // Group labels ride the cascade too so each header rises with its group.
            document.querySelectorAll('#settings-modal .settings-panel > .mb-10, #settings-modal .settings-panel > .settings-group-label').forEach((sec, i) => {
                sec.style.animationDelay = `${Math.min(0.06 + i * 0.035, 0.34)}s`;
            });
            cancelModalClose(document.getElementById('settings-modal'));
            document.getElementById('settings-modal').classList.remove('hidden');
        }

        // Opens Settings and lands the user directly on the Pinned Apps board,
        // with a brief highlight — used by the first-launch "Add app" invite in
        // Quick Launch so a new user knows exactly where to add their own app.
        async function openQuickLaunchSettings() {
            await openSettings();
            // Wait a frame so the modal's entrance cascade has laid out before we
            // scroll/flash the target section.
            requestAnimationFrame(() => {
                const el = document.getElementById('settings-apps');
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('settings-flash');
                setTimeout(() => el.classList.remove('settings-flash'), 1600);
            });
        }

        function deleteApp(i) {
            pinnedApps.splice(i, 1);
            renderSettingsApps();
            renderApps();
            scheduleSettingsSave();
            showToast('App removed');
        }

        // Base Quick Launch caps at 6 tiles; Quick Launch Enhanced lifts the cap so
        // folders and auto-detected games have room.
        function quickLaunchAppLimit() {
            return (typeof isQuickLaunchEnhancedEnabled === 'function' && isQuickLaunchEnhancedEnabled()) ? 60 : 6;
        }

        function addNewApp() {
            if (pinnedApps.length >= quickLaunchAppLimit()) return;
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
            const enhanced = typeof isQuickLaunchEnhancedEnabled === 'function' && isQuickLaunchEnhancedEnabled();

            // ── Base Quick Launch: a fixed 6-slot board ───────────────────────
            // Empty slots are click-to-add; filled slots are draggable and dropping
            // one on another swaps their positions. This is where slots are chosen.
            if (!enhanced) {
                const slots = typeof baseSlotLayout === 'function' ? baseSlotLayout(6) : new Array(6).fill(null);
                const full = pinnedApps.length >= quickLaunchAppLimit();
                container.innerHTML = slots.map((cell, slot) => {
                    if (!cell) {
                        // Empty slot: click to add here; also a drop target for moves.
                        return `
                        <div class="ql-slot-cell border border-neutral-700 border-dashed rounded-2xl p-4 bg-neutral-950/30 flex items-center justify-center ${full ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-neutral-900/40'} transition-colors" data-slot="${slot}"
                             ${full ? '' : `onclick="addAppToSlot(${slot})"`}
                             ondragover="slotDragOver(event)" ondragleave="slotDragLeave(event)" ondrop="slotDrop(event)">
                            <div class="text-center pointer-events-none">
                                <div class="text-3xl text-neutral-600 mb-1">+</div>
                                <p class="text-[10px] text-neutral-600 uppercase tracking-wider">Slot ${slot + 1}</p>
                            </div>
                        </div>`;
                    }
                    const { app, index } = cell;
                    return `
                    <div class="ql-slot-cell border border-neutral-800 rounded-2xl p-4 pt-7 bg-neutral-950/50 relative" draggable="true" data-slot="${slot}" data-index="${index}"
                         ondragstart="slotDragStart(event)" ondragend="slotDragEnd(event)" ondragover="slotDragOver(event)" ondragleave="slotDragLeave(event)" ondrop="slotDrop(event)">
                        <span class="absolute top-2 left-3 text-[10px] text-neutral-600 uppercase tracking-wider no-drag pointer-events-none">Slot ${slot + 1}</span>
                        <button onclick="deleteApp(${index})" class="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-xs bg-neutral-800/30 hover:bg-red-800/50 border border-neutral-700/50 hover:border-red-700/50 text-neutral-400 hover:text-red-400 rounded-lg transition-colors no-drag" title="Delete app">✕</button>
                        <div class="flex justify-center mb-3">
                            <img src="${esc(getIconPath(app.icon))}" draggable="false" class="w-14 h-14 object-contain rounded-xl pointer-events-none"
                                 onerror="this.outerHTML='<div class=\\'w-14 h-14 bg-neutral-800 rounded-xl flex items-center justify-center text-2xl text-neutral-500\\'>?</div>'">
                        </div>
                        <input type="text" value="${esc(app.name)}" onchange="updateAppName(${index}, this.value)"
                               class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm mb-2 focus:outline-none focus:border-neutral-600 no-drag">
                        <input type="text" value="${esc(app.path)}" onchange="updateAppPath(${index}, this.value)"
                               class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs mb-3 focus:outline-none focus:border-neutral-600 no-drag">
                        <button onclick="changeIcon(${index})" class="text-xs w-full py-2 border border-neutral-700 rounded-xl hover:bg-neutral-800 transition-colors no-drag">Change Icon</button>
                    </div>`;
                }).join('');
                return;
            }

            // ── Enhanced: packed card list with folders (no fixed slots) ──────
            const folders = typeof getQuickLaunchFolders === 'function' ? getQuickLaunchFolders() : [];
            const folderSelect = (app, i) => {
                const opts = ['<option value="">No folder</option>']
                    .concat(folders.map(f => `<option value="${esc(f)}"${(app.folder || '') === f ? ' selected' : ''}>${esc(f)}</option>`))
                    .join('');
                return `<select onchange="updateAppFolder(${i}, this.value)"
                           class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs mb-3 focus:outline-none focus:border-neutral-600 no-drag">${opts}</select>`;
            };
            let html = pinnedApps.map((app, i) => `
                <div class="border border-neutral-800 rounded-2xl p-4 bg-neutral-950/50 relative" draggable="true" data-index="${i}"
                     ondragstart="dragStart(event)" ondragover="dragOver(event)" ondrop="drop(event)">
                    <button onclick="deleteApp(${i})" class="absolute top-2 right-2 w-6 h-6 flex items-center justify-center text-xs bg-neutral-800/30 hover:bg-red-800/50 border border-neutral-700/50 hover:border-red-700/50 text-neutral-400 hover:text-red-400 rounded-lg transition-colors no-drag" title="Delete app">✕</button>
                    <div class="flex justify-center mb-3">
                        <img src="${esc(getIconPath(app.icon))}" draggable="false" class="w-14 h-14 object-contain rounded-xl pointer-events-none"
                             onerror="this.outerHTML='<div class=\\'w-14 h-14 bg-neutral-800 rounded-xl flex items-center justify-center text-2xl text-neutral-500\\'>?</div>'">
                    </div>
                    <input type="text" value="${esc(app.name)}" onchange="updateAppName(${i}, this.value)"
                           class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm mb-2 focus:outline-none focus:border-neutral-600">
                    <input type="text" value="${esc(app.path)}" onchange="updateAppPath(${i}, this.value)"
                           class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs mb-3 focus:outline-none focus:border-neutral-600">
                    ${folderSelect(app, i)}
                    <button onclick="changeIcon(${i})" class="text-xs w-full py-2 border border-neutral-700 rounded-xl hover:bg-neutral-800 transition-colors">Change Icon</button>
                </div>
            `).join('');

            if (pinnedApps.length < quickLaunchAppLimit()) {
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

        // Add a fresh app pinned directly to the clicked slot. Existing apps are
        // materialized into explicit slots first so they don't shuffle.
        function addAppToSlot(slot) {
            if (pinnedApps.length >= quickLaunchAppLimit()) { showToast('All slots are full', true); return; }
            if (typeof baseSlotLayout === 'function') {
                baseSlotLayout(6).forEach((cell, s) => { if (cell) cell.app.slot = s; });
            }
            pinnedApps.push({ name: 'New App', path: '', icon: 'main.ico', slot });
            localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
            scheduleSettingsSave();
            renderSettingsApps();
            renderApps();
            showToast(`Added app to slot ${slot + 1}`);
        }

        // ── Slot board drag-and-drop (base mode) ──────────────────────────────
        // Drag a filled slot onto any slot to move it; dropping on an occupied slot
        // swaps the two. The whole card is the drag ghost (icon can't tear off).
        let settingsDraggedIndex = null;

        function slotDragStart(e) {
            const card = e.currentTarget;
            settingsDraggedIndex = parseInt(card.dataset.index, 10);
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(settingsDraggedIndex));
                e.dataTransfer.setDragImage(card, card.offsetWidth / 2, card.offsetHeight / 2);
            } catch (_) {}
            card.classList.add('ql-dragging');
        }

        function slotDragEnd(e) {
            e.currentTarget.classList.remove('ql-dragging');
            document.querySelectorAll('#settings-apps .ql-slot-over').forEach(el => el.classList.remove('ql-slot-over'));
            settingsDraggedIndex = null;
        }

        function slotDragOver(e) {
            if (settingsDraggedIndex === null) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            e.currentTarget.classList.add('ql-slot-over');
        }

        function slotDragLeave(e) {
            e.currentTarget.classList.remove('ql-slot-over');
        }

        function slotDrop(e) {
            e.preventDefault();
            e.currentTarget.classList.remove('ql-slot-over');
            if (settingsDraggedIndex === null) return;
            const targetSlot = parseInt(e.currentTarget.dataset.slot, 10);
            const dragged = settingsDraggedIndex;
            settingsDraggedIndex = null;
            if (Number.isInteger(targetSlot)) moveAppToSlot(dragged, targetSlot);
        }

        // Move an app into a target slot, swapping with whatever app is there.
        function moveAppToSlot(draggedIndex, targetSlot) {
            const dragged = pinnedApps[draggedIndex];
            if (!dragged) { renderSettingsApps(); return; }
            const layout = typeof baseSlotLayout === 'function' ? baseSlotLayout(6) : new Array(6).fill(null);
            // Materialize current positions so the swap is deterministic.
            layout.forEach((cell, s) => { if (cell) cell.app.slot = s; });
            const from = dragged.slot;
            if (from !== targetSlot) {
                const occupant = layout[targetSlot] ? layout[targetSlot].app : null;
                dragged.slot = targetSlot;
                if (occupant && occupant !== dragged) occupant.slot = from;
            }
            localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
            scheduleSettingsSave();
            renderApps();
            renderSettingsApps();
        }

        // Enhanced-mode card reorder (packed array order, no fixed slots).
        function dragStart(e) {
            const card = e.currentTarget;
            draggedIndex = parseInt(card.dataset.index, 10);
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(draggedIndex));
                e.dataTransfer.setDragImage(card, card.offsetWidth / 2, card.offsetHeight / 2);
            } catch (_) {}
        }
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

        // Quick Launch Enhanced: assign an app to a folder (empty = ungrouped).
        function updateAppFolder(i, val) {
            if (!pinnedApps[i]) return;
            if (val) pinnedApps[i].folder = val;
            else delete pinnedApps[i].folder;
            scheduleSettingsSave();
            renderApps();
        }

        // Windows Explorer's "Copy as path" wraps the path in double quotes;
        // strip surrounding quotes so pasted paths launch without manual cleanup.
        function cleanAppPath(val) {
            let p = String(val).trim();
            while (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
                p = p.slice(1, -1).trim();
            }
            return p;
        }

        function updateAppPath(i, val) {
            const cleaned = cleanAppPath(val);
            pinnedApps[i].path = cleaned;
            scheduleSettingsSave();
            // onchange fires on blur/Enter, so re-rendering here is safe and
            // makes the field show the corrected path immediately.
            if (cleaned !== val) renderSettingsApps();
        }

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
                miniWidgetFavs: safeParseJSON(localStorage.getItem('miniWidgetFavs'), []),
                miniWidgetRecents: safeParseJSON(localStorage.getItem('miniWidgetRecents'), []),
                widgetLibCategory: localStorage.getItem('widgetLibCategory') || 'All',
                glowIntensity: localStorage.getItem('glowIntensity') || 'medium',
                parallaxEnabled: localStorage.getItem('parallaxEnabled') === 'true',
                backgroundSettings: getBgSettings(),
                spotifyAutoPlay: localStorage.getItem('spotifyAutoPlay') === 'true',
                spotifyAutoPlayDelay: localStorage.getItem('spotifyAutoPlayDelay') || '2800',
                lyricsAnticipateMs: localStorage.getItem('lyricsAnticipateMs') || String(DEFAULT_LYRICS_ANTICIPATE_MS),
                screenResFavourites: safeParseJSON(localStorage.getItem('screenResFavourites'), {}),
                spotifyFavPlaylists: safeParseJSON(localStorage.getItem('spotifyFavPlaylists'), []),
                spotifyPlaylistSort: localStorage.getItem('spotifyPlaylistSort') || 'recent',
                spotifyEwDraggable: localStorage.getItem('spotifyEwDraggable') || '0',
                spotifyEwPos: safeParseJSON(localStorage.getItem('spotifyEwPos'), {}),
                notesEnhancedData: safeParseJSON(localStorage.getItem('notesEnhancedData'), null),
                notesHistory: safeParseJSON(localStorage.getItem('notesHistory'), {}),
                quickLaunchFolders: safeParseJSON(localStorage.getItem('quickLaunchFolders'), null),
                launchProfiles: safeParseJSON(localStorage.getItem('launchProfiles'), []),
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
                        if (data.miniWidgetFavs) localStorage.setItem('miniWidgetFavs', JSON.stringify(data.miniWidgetFavs));
                        if (data.miniWidgetRecents) localStorage.setItem('miniWidgetRecents', JSON.stringify(data.miniWidgetRecents));
                        if (data.widgetLibCategory) localStorage.setItem('widgetLibCategory', data.widgetLibCategory);
                        if (data.miniWidgetPrefs) {
                            localStorage.setItem('miniWidgetPrefs', JSON.stringify(data.miniWidgetPrefs));
                        }
                        if (data.miniWidgetPrefs || data.miniWidgetFavs) {
                            renderMiniWidgetsSettings();
                            await applyMiniWidgetPrefs(); // also refreshes the dashboard strip
                        }
                        if (data.glowIntensity) localStorage.setItem('glowIntensity', data.glowIntensity);
                        if (data.backgroundSettings && typeof data.backgroundSettings === 'object') {
                            // Merge over defaults so a backup from a future/older version
                            // with missing keys still lands in a valid state.
                            setBgSettings(data.backgroundSettings);
                            applyBackground();
                            renderBackgroundSettings();
                        }
                        if (typeof data.parallaxEnabled === 'boolean') {
                            localStorage.setItem('parallaxEnabled', data.parallaxEnabled ? 'true' : 'false');
                            loadParallaxPref();
                        }
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
                        if (data.screenResFavourites) {
                            localStorage.setItem('screenResFavourites', JSON.stringify(data.screenResFavourites));
                        }
                        if (data.spotifyFavPlaylists) {
                            localStorage.setItem('spotifyFavPlaylists', JSON.stringify(data.spotifyFavPlaylists));
                        }
                        if (data.spotifyPlaylistSort) {
                            localStorage.setItem('spotifyPlaylistSort', data.spotifyPlaylistSort);
                        }
                        if (typeof data.spotifyEwDraggable !== 'undefined') {
                            localStorage.setItem('spotifyEwDraggable', data.spotifyEwDraggable === '1' || data.spotifyEwDraggable === true ? '1' : '0');
                        }
                        if (data.spotifyEwPos) {
                            localStorage.setItem('spotifyEwPos', JSON.stringify(data.spotifyEwPos));
                        }
                        if (typeof applySpotifyEwDraggable === 'function') applySpotifyEwDraggable();
                        if (data.notesEnhancedData) localStorage.setItem('notesEnhancedData', JSON.stringify(data.notesEnhancedData));
                        if (data.notesHistory) localStorage.setItem('notesHistory', JSON.stringify(data.notesHistory));
                        if (data.quickLaunchFolders) localStorage.setItem('quickLaunchFolders', JSON.stringify(data.quickLaunchFolders));
                        if (data.launchProfiles) localStorage.setItem('launchProfiles', JSON.stringify(data.launchProfiles));
                        applyWidgetPrefs();
                        applyAppearance();
                        applyParallaxPref();
                        if (typeof applyNotesEnhancedEnabled === 'function') applyNotesEnhancedEnabled(isNotesEnhancedEnabled());
                        if (typeof applyQuickLaunchEnhancedEnabled === 'function') applyQuickLaunchEnhancedEnabled(isQuickLaunchEnhancedEnabled());
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

