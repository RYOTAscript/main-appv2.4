        function esc(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;');
        }

        // Custom launcher icons (chosen via the icon picker) are saved under
        // %APPDATA%/main-launcher/icons — see main/appLauncher.js — rather than
        // next to the app's own bundled icons, so they survive reinstalls/updates
        // and don't need write access to the install directory. Their value is
        // tagged "custom:<filename>" so this can tell them apart from the plain
        // filenames used for the app's built-in default icons (chrome.ico, etc.),
        // which still resolve relative to the app's own install directory.
        function iconFileUrl(absPath) {
            const parts = absPath.replace(/\\/g, '/').split('/');
            return 'file:///' + parts.map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
        }

        function getIconPath(icon) {
            if (!icon) return '';
            if (icon.startsWith('custom:')) {
                const filename = icon.slice('custom:'.length);
                const base = window.electronAPI?.iconsBasePath;
                if (base) return iconFileUrl(`${base}\\${filename}`);
            }
            return `icons/${icon}`;
        }

        let toastHideTimer = null;

        function showToast(message, isError = false, durationMs = 2200) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.className = `absolute bottom-8 left-1/2 -translate-x-1/2 glass border px-6 py-3 rounded-2xl text-sm z-[70] glow pointer-events-none ${isError ? 'border-red-900/50 text-red-300' : 'border-white/10'}`;
            // Forced reflow so re-adding .toast-in restarts the slide-up even
            // when a toast is already on screen (rapid successive toasts).
            void toast.offsetWidth;
            toast.classList.add('toast-in');
            // Cancel the previous toast's hide timer so a rapid second toast
            // gets its full display time instead of being cut short.
            if (toastHideTimer) clearTimeout(toastHideTimer);
            toastHideTimer = setTimeout(() => {
                toast.classList.remove('toast-in');
                toast.classList.add('toast-out');
                // Matches the toastOut animation duration in main.css.
                toastHideTimer = setTimeout(() => {
                    toast.classList.add('hidden');
                    toast.classList.remove('toast-out');
                    toastHideTimer = null;
                }, 240);
            }, durationMs);
        }

        // Plays the modal exit animation (.modal-closing in main.css), then hides
        // the modal. `done` overrides the default hide for modals that toggle
        // visibility with something other than the `hidden` class.
        const MODAL_CLOSE_MS = 200;

        function animateModalClose(modal, done) {
            if (!modal || modal.classList.contains('modal-closing')) return;
            modal.classList.add('modal-closing');
            modal._closeTimer = setTimeout(() => {
                modal._closeTimer = null;
                modal.classList.remove('modal-closing');
                if (done) done();
                else modal.classList.add('hidden');
            }, MODAL_CLOSE_MS);
        }

        // Open paths must call this first: re-opening a modal during its 200ms
        // exit animation would otherwise get hidden again when the timer fires.
        function cancelModalClose(modal) {
            if (!modal || !modal._closeTimer) return;
            clearTimeout(modal._closeTimer);
            modal._closeTimer = null;
            modal.classList.remove('modal-closing');
        }

        function minimizeWindow() {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        }

        function closeApp() {
            if (window.electronAPI) window.electronAPI.closeWindow();
        }

        // Icons cascade in on the very first render only. Re-renders (reordering
        // or editing apps in Settings) must not replay the entrance animation.
        let appsRevealPlayed = false;

        // Base Quick Launch is a fixed 6-slot grid. Apps carry an optional `slot`
        // (0-5) so you can place a handful of apps in specific positions and leave
        // gaps. Apps without an explicit slot fill the first free cells in order.
        const QL_BASE_SLOTS = 6;

        function baseSlotLayout(limit = QL_BASE_SLOTS) {
            const slots = new Array(limit).fill(null);
            const overflow = [];
            pinnedApps.forEach((app, index) => {
                let s = app.slot;
                if (typeof s === 'string' && s !== '') s = parseInt(s, 10);
                if (Number.isInteger(s) && s >= 0 && s < limit && slots[s] === null) {
                    slots[s] = { app, index };
                } else {
                    overflow.push({ app, index });
                }
            });
            let o = 0;
            for (let i = 0; i < limit && o < overflow.length; i++) {
                if (!slots[i]) slots[i] = overflow[o++];
            }
            return slots;
        }

        // First-launch only: a ghost "add your own app" tile shown as the 6th
        // Quick Launch slot, inviting a brand-new user to pin something of their
        // own next to the starter defaults. Opens Settings. Gated on
        // window.__mainFirstLaunch (set at boot in renderer/spotify-widget.js) so
        // it only ever appears on the very first launch, then disappears for good.
        function quickLaunchAddTile(reveal, delayIndex) {
            return `
                <button type="button" onclick="openQuickLaunchSettings()" aria-label="Add your own app to Quick Launch"
                    class="app-icon ql-add-tile flex flex-col items-center py-3 px-2 rounded-3xl${reveal ? ' app-reveal' : ''}"${reveal ? ` style="animation-delay:${(0.12 + delayIndex * 0.05).toFixed(2)}s"` : ''}>
                    <div class="icon-tile w-16 h-16 rounded-3xl flex items-center justify-center mb-2.5">
                        <i class="fas fa-plus text-2xl text-neutral-400"></i>
                    </div>
                    <span class="ql-add-label text-[11px] text-center leading-tight">Add app</span>
                </button>`;
        }

        function renderApps() {
            const grid = document.getElementById('apps-grid');
            const reveal = !appsRevealPlayed;
            appsRevealPlayed = true;

            // Quick Launch Enhanced: folders + running-app indicators. When it's off
            // the launcher renders a fixed 6-slot grid (drag a tile onto any slot).
            const enhanced = typeof isQuickLaunchEnhancedEnabled === 'function' && isQuickLaunchEnhancedEnabled();

            if (!enhanced) {
                // Fixed 6-slot layout. Empty slots are invisible spacers so apps
                // sit in their chosen positions (with gaps) but the launcher stays
                // clean — slots are assigned from Settings, not by dragging here.
                const slots = baseSlotLayout(QL_BASE_SLOTS);
                // First launch only: turn the first empty slot into an "add your
                // own app" invite. Returning users keep the clean invisible-spacer
                // behaviour untouched.
                const addSlot = window.__mainFirstLaunch ? slots.findIndex(c => !c) : -1;
                grid.innerHTML = slots.map((cell, slot) => {
                    if (!cell) return slot === addSlot
                        ? quickLaunchAddTile(reveal, slot)
                        : `<div class="app-slot-empty" aria-hidden="true"></div>`;
                    const { app, index } = cell;
                    return `
                    <div class="app-icon flex flex-col items-center cursor-pointer py-3 px-2 rounded-3xl border border-transparent hover:border-white/10${reveal ? ' app-reveal' : ''}"${reveal ? ` style="animation-delay:${0.12 + slot * 0.05}s"` : ''} data-index="${index}">
                        <div class="icon-tile w-16 h-16 bg-neutral-950 border border-white/10 rounded-3xl flex items-center justify-center overflow-hidden mb-2.5 transition-all relative">
                            <img src="${esc(getIconPath(app.icon))}" alt="" style="width:70%;height:70%;object-fit:contain;"
                                 onerror="this.outerHTML='<i class=\\'fas fa-bolt text-3xl text-neutral-400\\'></i>';">
                        </div>
                        <span class="text-[11px] text-neutral-500 text-center leading-tight">${esc(app.name)}</span>
                    </div>`;
                }).join('');
                return;
            }

            const activeFolder = typeof quickLaunchActiveFolder !== 'undefined' ? quickLaunchActiveFolder : 'All';
            const runningSet = typeof quickLaunchRunningSet !== 'undefined' ? quickLaunchRunningSet : null;

            // Keep data-index pointing at the real pinnedApps index so clicks always
            // launch the right app even when a folder filter hides some tiles.
            const entries = pinnedApps
                .map((app, i) => ({ app, i }))
                .filter(({ app }) => appMatchesFolder(app, activeFolder));

            let html = entries.map(({ app, i }, pos) => {
                const running = runningSet && appIsRunning(app, runningSet);
                return `
                <div class="app-icon flex flex-col items-center cursor-pointer py-3 px-2 rounded-3xl border border-transparent hover:border-white/10${reveal ? ' app-reveal' : ''}"${reveal ? ` style="animation-delay:${0.12 + pos * 0.05}s"` : ''} data-index="${i}">
                    <div class="icon-tile w-16 h-16 bg-neutral-950 border border-white/10 rounded-3xl flex items-center justify-center overflow-hidden mb-2.5 transition-all relative">
                        <img src="${esc(getIconPath(app.icon))}" alt="" style="width:70%;height:70%;object-fit:contain;"
                             onerror="this.outerHTML='<i class=\\'fas fa-bolt text-3xl text-neutral-400\\'></i>';">
                        ${running ? '<span class="app-running-dot" title="Running"></span>' : ''}
                    </div>
                    <span class="text-[11px] ${running ? 'text-emerald-400' : 'text-neutral-500'} text-center leading-tight">${esc(app.name)}</span>
                </div>`;
            }).join('');

            // First launch only: append an "add your own app" invite as the next
            // tile in the default (All) view, so a new user sees a 6th slot to
            // make the launcher their own. Only while the first row has room —
            // once they've filled all six, the invite disappears.
            if (window.__mainFirstLaunch && activeFolder === 'All' && entries.length < QL_BASE_SLOTS) {
                html += quickLaunchAddTile(reveal, entries.length);
            }
            grid.innerHTML = html;

            if (typeof renderQuickLaunchBar === 'function') renderQuickLaunchBar();
        }

        document.getElementById('apps-grid').addEventListener('click', (e) => {
            const tile = e.target.closest('[data-index]');
            if (!tile) return;
            const app = pinnedApps[parseInt(tile.dataset.index, 10)];
            if (app) launchApp(app.path, app.name);
        });

        async function launchApp(fullPath, name) {
            // Auto-detected store games are pinned with a protocol URI (steam://,
            // com.epicgames.launcher://) as their path — launch those through the
            // store client rather than the file-path launcher.
            if (typeof fullPath === 'string' && /^(steam|com\.epicgames\.launcher):/i.test(fullPath.trim())) {
                showToast(`Launching ${name}...`);
                try {
                    const res = await window.electronAPI?.quickLaunchLaunchUri(fullPath.trim());
                    if (res && !res.success) showToast(`Failed: ${res.error || 'unknown error'}`, true);
                } catch (e) {
                    showToast('Launch failed', true);
                    console.error(e);
                }
                return;
            }

            showToast(`Launching ${name}...`);
            try {
                if (!window.electronAPI) return;
                const autoPlay = name === 'Spotify' && localStorage.getItem('spotifyAutoPlay') === 'true';
                const autoPlayDelay = parseInt(localStorage.getItem('spotifyAutoPlayDelay') || '2800', 10);
                const result = await window.electronAPI.launchApp(fullPath, { autoPlay, autoPlayDelay });
                if (result && !result.success) {
                    showToast(`Failed: ${result.error || 'unknown error'}`, true);
                }
            } catch (e) {
                showToast('Launch failed', true);
                console.error(e);
            }
        }

        function flashStat(valId, barId) {
            const val = document.getElementById(valId);
            const bar = document.getElementById(barId);
            val.classList.remove('stat-bump');
            bar.classList.remove('stat-bump');
            void val.offsetWidth;
            val.classList.add('stat-bump');
            bar.classList.add('stat-bump');
            setTimeout(() => {
                val.classList.remove('stat-bump');
                bar.classList.remove('stat-bump');
            }, 700);
        }

        function updateStat(valId, barId, newVal, oldVal) {
            document.getElementById(valId).textContent = `${newVal}%`;
            document.getElementById(barId).style.width = `${newVal}%`;
            if (oldVal !== null && oldVal !== newVal) flashStat(valId, barId);
        }


        async function loadSystemStats() {
            const label = document.getElementById('stats-label');
            const liveDot = document.getElementById('stats-live-dot');
            if (!window.electronAPI?.getSystemStats) return;

            try {
                const { cpu, ram } = await window.electronAPI.getSystemStats();
                updateStat('cpu-val', 'cpu-bar', cpu, lastCpu);
                updateStat('ram-val', 'ram-bar', ram, lastRam);
                lastCpu = cpu;
                lastRam = ram;
                label.textContent = 'live';
                liveDot.classList.remove('hidden');
            } catch (e) {
                label.textContent = 'unavailable';
                liveDot.classList.add('hidden');
            }
        }

        function startPerformanceMonitor() {
            stopPerformanceMonitor();
            const prefs = safeParseJSON(localStorage.getItem('widgetPrefs'), { notes: true, performance: true, spotify: true });
            if (!prefs.performance) return;
            loadSystemStats();
            statsInterval = setInterval(loadSystemStats, 2500);
        }

        function stopPerformanceMonitor() {
            if (statsInterval) {
                clearInterval(statsInterval);
                statsInterval = null;
            }
        }

