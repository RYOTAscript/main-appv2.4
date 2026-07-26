        // ── Quick Launch Enhanced ─────────────────────────────────────────────
        //
        // An opt-in mini widget (id 'launchEnhanced') that upgrades Quick Launch
        // with folders/groups (Games, Work, custom), auto-detection of installed
        // Steam/Epic games (auto-filed into the Games folder), launch profiles
        // (launch several apps at once), and running-app indicator dots.
        //
        // Off by default. When disabled, Quick Launch behaves exactly as before —
        // every pinned app shown, no folders, no dots. The existing `pinnedApps`
        // array is reused; enhanced fields are optional and back-compatible:
        //   app.folder  string|undefined  which folder the app belongs to
        //   app.exe     string|undefined  exe basename for running detection
        //   (app.path may be a steam:// / com.epicgames.launcher:// URI for games)
        //
        // Storage (localStorage):
        //   quickLaunchFolders   ['Games','Work', ...]   (custom folders append)
        //   launchProfiles       [ {id,name,paths:[...]} ]
        //   quickLaunchFolder    last-selected folder tab (session convenience)

        const DEFAULT_QL_FOLDERS = ['Games', 'Work'];
        const QL_RUNNING_POLL_MS = 5000;

        let quickLaunchActiveFolder = localStorage.getItem('quickLaunchFolder') || 'All';
        // Set of lower-cased exe basenames currently running (for indicator dots).
        let quickLaunchRunningSet = new Set();
        let quickLaunchRunningTimer = null;

        function isQuickLaunchEnhancedEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.launchEnhanced;
        }

        function getQuickLaunchFolders() {
            const f = safeParseJSON(localStorage.getItem('quickLaunchFolders'), null);
            if (Array.isArray(f) && f.length) return f;
            return [...DEFAULT_QL_FOLDERS];
        }

        function saveQuickLaunchFolders(folders) {
            localStorage.setItem('quickLaunchFolders', JSON.stringify(folders));
            scheduleSettingsSave();
        }

        function getLaunchProfiles() {
            return safeParseJSON(localStorage.getItem('launchProfiles'), []);
        }

        function saveLaunchProfiles(profiles) {
            localStorage.setItem('launchProfiles', JSON.stringify(profiles));
            scheduleSettingsSave();
        }

        // ── Folder membership / running match ─────────────────────────────────

        function appMatchesFolder(app, folder) {
            if (folder === 'All') return true;
            return (app.folder || '') === folder;
        }

        // Derive the process image name for an app: prefer an explicit exe (set on
        // auto-detected games), else the basename of a local exe path.
        function appProcessName(app) {
            if (app.exe) return app.exe.split(/[\\/]/).pop().toLowerCase();
            const p = app.path || '';
            if (/^[a-z][a-z0-9.+-]*:\/\//i.test(p)) return null; // URI, no local exe
            const base = p.split(/[\\/]/).pop();
            return base ? base.toLowerCase() : null;
        }

        function appIsRunning(app, runningSet) {
            const name = appProcessName(app);
            return !!name && runningSet.has(name);
        }

        // ── Enable / apply ────────────────────────────────────────────────────

        function applyQuickLaunchEnhancedEnabled(enabled) {
            const controls = document.getElementById('quick-launch-controls');
            const folders = document.getElementById('quick-launch-folders');
            if (controls) controls.classList.toggle('hidden', !enabled);
            if (folders) folders.classList.toggle('hidden', !enabled);
            if (enabled) {
                startQuickLaunchRunningPoll();
            } else {
                stopQuickLaunchRunningPoll();
                quickLaunchRunningSet = new Set();
            }
            renderApps();
        }

        // ── Running-app polling ───────────────────────────────────────────────

        async function refreshRunningApps() {
            if (!isQuickLaunchEnhancedEnabled() || !window.electronAPI?.quickLaunchRunning) return;
            const names = [...new Set(pinnedApps.map(appProcessName).filter(Boolean))];
            if (!names.length) { quickLaunchRunningSet = new Set(); return; }
            try {
                const running = await window.electronAPI.quickLaunchRunning(names);
                const next = new Set((running || []).map(n => String(n).toLowerCase()));
                // Only re-render if the running set actually changed.
                const changed = next.size !== quickLaunchRunningSet.size ||
                    [...next].some(n => !quickLaunchRunningSet.has(n));
                quickLaunchRunningSet = next;
                if (changed) renderApps();
            } catch (e) {
                console.error('Quick Launch running poll failed', e);
            }
        }

        function startQuickLaunchRunningPoll() {
            stopQuickLaunchRunningPoll();
            refreshRunningApps();
            quickLaunchRunningTimer = setInterval(refreshRunningApps, QL_RUNNING_POLL_MS);
        }

        function stopQuickLaunchRunningPoll() {
            if (quickLaunchRunningTimer) {
                clearInterval(quickLaunchRunningTimer);
                quickLaunchRunningTimer = null;
            }
        }

        // ── Folder + profile bar (dashboard) ──────────────────────────────────

        function renderQuickLaunchBar() {
            renderQuickLaunchFolders();
            renderQuickLaunchControls();
        }

        function renderQuickLaunchFolders() {
            const host = document.getElementById('quick-launch-folders');
            if (!host || host.classList.contains('hidden')) return;
            const folders = getQuickLaunchFolders();
            // Ensure the active folder still exists (a deleted folder falls back to All).
            if (quickLaunchActiveFolder !== 'All' && !folders.includes(quickLaunchActiveFolder)) {
                quickLaunchActiveFolder = 'All';
            }
            const count = (folder) => pinnedApps.filter(a => appMatchesFolder(a, folder)).length;
            const tab = (name, icon) => `
                <button type="button" class="ql-folder-tab no-drag${quickLaunchActiveFolder === name ? ' active' : ''}"
                    data-folder="${esc(name)}">
                    <i class="fas ${icon} text-[9px]"></i><span>${esc(name)}</span>
                    <span class="ql-folder-count">${count(name)}</span>
                </button>`;
            const iconFor = (name) => name === 'Games' ? 'fa-gamepad' : name === 'Work' ? 'fa-briefcase' : 'fa-folder';
            host.innerHTML =
                tab('All', 'fa-layer-group') +
                folders.map(f => tab(f, iconFor(f))).join('') +
                `<button type="button" class="ql-folder-add no-drag" data-act="add-folder" title="New folder"><i class="fas fa-plus text-[9px]"></i></button>`;

            host.querySelectorAll('.ql-folder-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    quickLaunchActiveFolder = btn.dataset.folder;
                    localStorage.setItem('quickLaunchFolder', quickLaunchActiveFolder);
                    renderApps();
                });
            });
            const addBtn = host.querySelector('[data-act="add-folder"]');
            if (addBtn) addBtn.addEventListener('click', quickLaunchAddFolder);
        }

        function renderQuickLaunchControls() {
            const host = document.getElementById('quick-launch-controls');
            if (!host || host.classList.contains('hidden')) return;
            const profiles = getLaunchProfiles();
            const profileBtns = profiles.map(p => `
                <button type="button" class="ql-profile-btn no-drag" data-profile="${p.id}" title="Launch ${esc(p.name)} (${p.paths.length} app${p.paths.length === 1 ? '' : 's'})">
                    <i class="fas fa-bolt text-[9px]"></i><span>${esc(p.name)}</span>
                </button>`).join('');
            host.innerHTML = `
                ${profileBtns}
                <button type="button" class="ql-ctrl-btn no-drag" data-act="detect" title="Auto-detect installed games">
                    <i class="fas fa-magnifying-glass text-[10px]"></i><span>Detect Games</span>
                </button>`;

            host.querySelectorAll('[data-profile]').forEach(btn => {
                btn.addEventListener('click', () => runLaunchProfile(btn.dataset.profile));
            });
            const detect = host.querySelector('[data-act="detect"]');
            if (detect) detect.addEventListener('click', detectAndAddGames);
        }

        // ── Folder management ─────────────────────────────────────────────────

        function quickLaunchAddFolder() {
            const name = (prompt('New folder name:') || '').trim();
            if (!name) return;
            const folders = getQuickLaunchFolders();
            if (folders.includes(name) || name === 'All') {
                showToast('Folder already exists', true);
                return;
            }
            folders.push(name);
            saveQuickLaunchFolders(folders);
            quickLaunchActiveFolder = name;
            localStorage.setItem('quickLaunchFolder', name);
            renderApps();
            if (typeof renderSettingsApps === 'function') renderSettingsApps();
        }

        // ── Auto-detect games ─────────────────────────────────────────────────

        async function detectAndAddGames() {
            if (!window.electronAPI?.quickLaunchDetectGames) {
                showToast('Game detection unavailable', true);
                return;
            }
            showToast('Scanning for installed games…');
            let games = [];
            try {
                games = await window.electronAPI.quickLaunchDetectGames();
            } catch (e) {
                console.error('Game detection failed', e);
                showToast('Game detection failed', true);
                return;
            }
            if (!games || !games.length) {
                showToast('No Steam or Epic games found', true);
                return;
            }
            // Ensure the Games folder exists.
            const folders = getQuickLaunchFolders();
            if (!folders.includes('Games')) { folders.push('Games'); saveQuickLaunchFolders(folders); }

            // De-dupe against apps already pinned (by launch URI or path).
            const existing = new Set(pinnedApps.map(a => (a.path || '').toLowerCase()));
            let added = 0;
            for (const g of games) {
                const launchPath = g.uri || g.exe;
                if (!launchPath || existing.has(launchPath.toLowerCase())) continue;
                pinnedApps.push({
                    name: g.name,
                    path: launchPath,
                    icon: g.store === 'epic' ? 'main.ico' : 'main.ico',
                    folder: 'Games',
                    exe: g.exe ? g.exe.split(/[\\/]/).pop() : undefined,
                    store: g.store
                });
                existing.add(launchPath.toLowerCase());
                added++;
            }
            if (!added) {
                showToast('All detected games are already added');
                return;
            }
            localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
            scheduleSettingsSave();
            quickLaunchActiveFolder = 'Games';
            localStorage.setItem('quickLaunchFolder', 'Games');
            renderApps();
            refreshRunningApps();
            if (typeof renderSettingsApps === 'function') renderSettingsApps();
            showToast(`Added ${added} game${added === 1 ? '' : 's'} to Games`);
        }

        // ── Launch profiles ───────────────────────────────────────────────────

        async function runLaunchProfile(id) {
            const profile = getLaunchProfiles().find(p => p.id === id);
            if (!profile || !profile.paths.length) {
                showToast('Profile is empty', true);
                return;
            }
            showToast(`Launching ${profile.name}…`);
            try {
                const res = await window.electronAPI?.quickLaunchLaunchMany(profile.paths);
                if (res) {
                    const msg = res.failed
                        ? `${profile.name}: ${res.launched} launched, ${res.failed} failed`
                        : `${profile.name}: launched ${res.launched} app${res.launched === 1 ? '' : 's'}`;
                    showToast(msg, res.failed > 0);
                }
                setTimeout(refreshRunningApps, 1500);
            } catch (e) {
                console.error('Launch profile failed', e);
                showToast('Launch profile failed', true);
            }
        }

        // ── Config panel (Widget Library detail) ──────────────────────────────
        // No-ops when its panel div is absent (only present while the detail view
        // is open), per the Widget Library contract.

        function renderQuickLaunchEnhancedPanel() {
            const panel = document.getElementById('launch-enhanced-panel');
            if (!panel) return;
            if (!isQuickLaunchEnhancedEnabled()) {
                panel.innerHTML = `<p class="text-xs text-neutral-500 leading-relaxed">
                    Enable Quick Launch Enhanced to organise apps into folders (Games,
                    Work, custom), auto-detect installed Steam/Epic games, build launch
                    profiles that open several apps at once, and see which apps are
                    running. Your pinned apps are kept.</p>`;
                return;
            }
            const folders = getQuickLaunchFolders();
            const profiles = getLaunchProfiles();
            const appOptions = pinnedApps.map((a, i) =>
                `<label class="ql-prof-app"><input type="checkbox" value="${i}" class="ql-prof-app-cb"> <span>${esc(a.name)}</span></label>`
            ).join('') || '<p class="text-[11px] text-neutral-600">No apps pinned yet.</p>';

            const folderRows = folders.map(f => `
                <span class="ql-panel-chip">
                    <i class="fas ${f === 'Games' ? 'fa-gamepad' : f === 'Work' ? 'fa-briefcase' : 'fa-folder'} text-[9px]"></i>
                    ${esc(f)}
                    ${DEFAULT_QL_FOLDERS.includes(f) ? '' : `<button type="button" class="ql-panel-chip-del" data-delfolder="${esc(f)}" title="Delete folder">✕</button>`}
                </span>`).join('');

            const profileRows = profiles.length ? profiles.map(p => `
                <div class="ql-panel-profile">
                    <div class="min-w-0">
                        <p class="text-xs text-neutral-300 truncate">${esc(p.name)}</p>
                        <p class="text-[10px] text-neutral-600">${p.paths.length} app${p.paths.length === 1 ? '' : 's'}</p>
                    </div>
                    <button type="button" class="ql-panel-profile-del no-drag" data-delprofile="${p.id}" title="Delete profile"><i class="fas fa-trash text-[9px]"></i></button>
                </div>`).join('') : '<p class="text-[11px] text-neutral-600">No profiles yet.</p>';

            panel.innerHTML = `
                <div class="border border-white/10 rounded-xl p-4 space-y-4">
                    <div>
                        <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-2">Folders</p>
                        <div class="flex flex-wrap gap-2">${folderRows}
                            <button type="button" class="ql-panel-chip ql-panel-chip-add no-drag" data-act="add-folder"><i class="fas fa-plus text-[9px]"></i> Add</button>
                        </div>
                        <p class="text-[10px] text-neutral-600 mt-2">Assign an app to a folder from the app's card in Settings → Quick Launch.</p>
                    </div>
                    <div>
                        <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-2">Auto-detect</p>
                        <button type="button" class="ql-panel-btn no-drag" data-act="detect"><i class="fas fa-magnifying-glass mr-1.5"></i>Detect installed games</button>
                    </div>
                    <div>
                        <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-2">Launch profiles</p>
                        <div class="space-y-1.5 mb-3">${profileRows}</div>
                        <div class="border border-neutral-800 rounded-lg p-3 space-y-2">
                            <input type="text" id="ql-new-profile-name" placeholder="New profile name" class="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-neutral-600">
                            <div class="ql-prof-apps">${appOptions}</div>
                            <button type="button" class="ql-panel-btn no-drag" data-act="create-profile"><i class="fas fa-plus mr-1.5"></i>Create profile</button>
                        </div>
                    </div>
                </div>`;

            // Wiring.
            panel.querySelector('[data-act="add-folder"]')?.addEventListener('click', () => { quickLaunchAddFolder(); renderQuickLaunchEnhancedPanel(); });
            panel.querySelector('[data-act="detect"]')?.addEventListener('click', async () => { await detectAndAddGames(); renderQuickLaunchEnhancedPanel(); });
            panel.querySelector('[data-act="create-profile"]')?.addEventListener('click', () => {
                const name = (document.getElementById('ql-new-profile-name')?.value || '').trim();
                if (!name) { showToast('Enter a profile name', true); return; }
                const paths = [...panel.querySelectorAll('.ql-prof-app-cb:checked')]
                    .map(cb => pinnedApps[parseInt(cb.value, 10)]?.path).filter(Boolean);
                if (!paths.length) { showToast('Select at least one app', true); return; }
                const profiles = getLaunchProfiles();
                profiles.push({ id: 'p' + Date.now().toString(36), name, paths });
                saveLaunchProfiles(profiles);
                renderQuickLaunchEnhancedPanel();
                renderApps();
                showToast('Profile created');
            });
            panel.querySelectorAll('[data-delprofile]').forEach(btn => btn.addEventListener('click', () => {
                saveLaunchProfiles(getLaunchProfiles().filter(p => p.id !== btn.dataset.delprofile));
                renderQuickLaunchEnhancedPanel();
                renderApps();
            }));
            panel.querySelectorAll('[data-delfolder]').forEach(btn => btn.addEventListener('click', () => {
                const f = btn.dataset.delfolder;
                saveQuickLaunchFolders(getQuickLaunchFolders().filter(x => x !== f));
                // Un-assign apps that were in the deleted folder.
                pinnedApps.forEach(a => { if (a.folder === f) delete a.folder; });
                localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
                if (quickLaunchActiveFolder === f) quickLaunchActiveFolder = 'All';
                renderQuickLaunchEnhancedPanel();
                renderApps();
                if (typeof renderSettingsApps === 'function') renderSettingsApps();
            }));
        }
