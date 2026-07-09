        // ── Spotify Enhanced mini widget ──
        // Layers a Queue Viewer, Playlist Shortcuts, Recently Played browser and a
        // Like/Unlike control on top of the existing Spotify integration. Everything
        // here is renderer-side; the main process (main/spotify.js) exposes the API
        // calls. When the widget is disabled none of this appears — the heart button
        // on the player stays hidden and the settings panel shows a hint. All the
        // heavy player logic (polling, current track) lives in spotify-widget.js;
        // this file only reads the shared `spotifyCurrentTrack` global from there.

        let spotifyEnhancedTab = 'queue';       // settings panel tab: queue | recent | playlists
        let spotifyEwTab = 'queue';             // inline player-strip tab (independent)
        let spotifyEnhancedCurrentSaved = null;  // like-state of the current track (null = unknown)
        let spotifyEnhancedNeedsReconnect = false;
        let spotifyEnhancedLikeBusy = false;

        // ── Playlist favourites, sort, and "recently opened" tracking (shared by the
        // settings panel and the inline player strip) ──
        function spotifyFavPlaylists() {
            return safeParseJSON(localStorage.getItem('spotifyFavPlaylists'), []);
        }
        function spotifyToggleFavPlaylist(id) {
            if (!id) return;
            const list = spotifyFavPlaylists();
            const i = list.indexOf(id);
            if (i >= 0) list.splice(i, 1); else list.push(id);
            localStorage.setItem('spotifyFavPlaylists', JSON.stringify(list));
            // Repaint wherever playlists are shown.
            if (spotifyEwTab === 'playlists') renderSpotifyEnhancedWidgetContent();
            if (spotifyEnhancedTab === 'playlists') renderSpotifyEnhancedPanel();
        }
        function spotifyPlaylistSortMode() {
            return localStorage.getItem('spotifyPlaylistSort') === 'alpha' ? 'alpha' : 'recent';
        }
        function spotifyToggleSortMode() {
            localStorage.setItem('spotifyPlaylistSort', spotifyPlaylistSortMode() === 'alpha' ? 'recent' : 'alpha');
            if (spotifyEwTab === 'playlists') renderSpotifyEnhancedWidgetContent();
            if (spotifyEnhancedTab === 'playlists') renderSpotifyEnhancedPanel();
        }
        function spotifyRecentPlaylists() {
            return safeParseJSON(localStorage.getItem('spotifyRecentPlaylists'), []);
        }
        function spotifyRecordPlaylistOpened(uri) {
            const m = /playlist:([A-Za-z0-9]+)/.exec(uri || '');
            if (!m) return;
            let list = spotifyRecentPlaylists().filter((x) => x !== m[1]);
            list.unshift(m[1]);
            localStorage.setItem('spotifyRecentPlaylists', JSON.stringify(list.slice(0, 50)));
        }
        // Favourites always float to the top; within favourites and within the rest,
        // order by the chosen sort (recently opened by default, or A→Z).
        function spotifySortPlaylists(items) {
            const favs = new Set(spotifyFavPlaylists());
            const recent = spotifyRecentPlaylists();
            const mode = spotifyPlaylistSortMode();
            const byMode = (a, b) => {
                if (mode === 'alpha') return (a.name || '').localeCompare(b.name || '');
                const ia = recent.indexOf(a.id), ib = recent.indexOf(b.id);
                return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
            };
            const favItems = items.filter((p) => favs.has(p.id)).sort(byMode);
            const rest = items.filter((p) => !favs.has(p.id)).sort(byMode);
            return [...favItems, ...rest];
        }

        // ── Draggable strip (optional; toggled in Settings) ──
        // When enabled, a grip handle appears at the top of the inline strip and the
        // user can drag it anywhere within the player. Position is remembered
        // separately for the two layout modes — "compact" (Spotify shares the player
        // with other widgets) and "solo" (full-width player) — because the strip has
        // very different default geometry in each, so one saved box wouldn't suit both.
        function spotifyEwDraggableEnabled() {
            return localStorage.getItem('spotifyEwDraggable') === '1';
        }
        function spotifyEwLayoutMode() {
            return document.getElementById('widget-spotify')?.classList.contains('spotify-solo') ? 'solo' : 'compact';
        }
        function spotifyEwPositions() {
            return safeParseJSON(localStorage.getItem('spotifyEwPos'), {});
        }
        function spotifyEwSavePosition(mode, box) {
            const all = spotifyEwPositions();
            all[mode] = box;
            localStorage.setItem('spotifyEwPos', JSON.stringify(all));
        }

        // Applies (or clears) the saved custom position for the current layout mode.
        // With dragging off, or no saved box for this mode, we strip the inline styles
        // so the stylesheet's default anchoring takes over again.
        function applyEwPosition() {
            const widget = document.getElementById('spotify-enhanced-widget');
            if (!widget) return;
            const clear = () => ['left', 'top', 'right', 'bottom', 'width', 'height']
                .forEach((p) => { widget.style[p] = ''; });
            if (!spotifyEwDraggableEnabled()) { clear(); return; }
            const box = spotifyEwPositions()[spotifyEwLayoutMode()];
            if (!box) { clear(); return; }
            widget.style.left = `${box.left}px`;
            widget.style.top = `${box.top}px`;
            widget.style.right = 'auto';
            widget.style.bottom = 'auto';
            if (box.width) widget.style.width = `${box.width}px`;
            if (box.height) widget.style.height = `${box.height}px`;
        }

        // Shows/hides the grip (via the .draggable class) and re-applies the position.
        function applySpotifyEwDraggable() {
            const widget = document.getElementById('spotify-enhanced-widget');
            if (!widget) return;
            const on = spotifyEwDraggableEnabled();
            widget.classList.toggle('draggable', on);
            if (on) initSpotifyEwDrag();   // ensure handlers are live before the first drag
            applyEwPosition();
        }

        function toggleSpotifyEwDraggable(on) {
            localStorage.setItem('spotifyEwDraggable', on ? '1' : '0');
            applySpotifyEwDraggable();
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            renderSpotifyEnhancedPanel();
        }

        function resetSpotifyEwPosition() {
            localStorage.removeItem('spotifyEwPos');
            applyEwPosition();
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            if (typeof showToast === 'function') showToast('Panel position reset');
        }

        // Binds the drag handlers exactly once (mousedown on the grip, plus document
        // move/up). Safe to call repeatedly — subsequent calls are no-ops.
        let spotifyEwDragBound = false;
        function initSpotifyEwDrag() {
            if (spotifyEwDragBound) return;
            const handle = document.getElementById('spotify-ew-drag');
            const widget = document.getElementById('spotify-enhanced-widget');
            if (!handle || !widget) return;
            spotifyEwDragBound = true;

            let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0, parent = null;

            handle.addEventListener('mousedown', (e) => {
                if (!spotifyEwDraggableEnabled()) return;
                e.preventDefault();
                parent = widget.offsetParent || widget.parentElement;
                if (!parent) return;
                const wRect = widget.getBoundingClientRect();
                const pRect = parent.getBoundingClientRect();
                // Freeze current pixel geometry before we switch to left/top anchoring,
                // otherwise the solo layout (height:auto, right/bottom anchored) collapses.
                baseLeft = wRect.left - pRect.left;
                baseTop = wRect.top - pRect.top;
                widget.style.left = `${baseLeft}px`;
                widget.style.top = `${baseTop}px`;
                widget.style.right = 'auto';
                widget.style.bottom = 'auto';
                widget.style.width = `${wRect.width}px`;
                widget.style.height = `${wRect.height}px`;
                startX = e.clientX;
                startY = e.clientY;
                dragging = true;
                widget.classList.add('dragging');
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging || !parent) return;
                const pRect = parent.getBoundingClientRect();
                const wRect = widget.getBoundingClientRect();
                let nl = baseLeft + (e.clientX - startX);
                let nt = baseTop + (e.clientY - startY);
                // Keep the strip fully inside the player.
                nl = Math.max(0, Math.min(nl, pRect.width - wRect.width));
                nt = Math.max(0, Math.min(nt, pRect.height - wRect.height));
                widget.style.left = `${nl}px`;
                widget.style.top = `${nt}px`;
            });

            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                widget.classList.remove('dragging');
                spotifyEwSavePosition(spotifyEwLayoutMode(), {
                    left: parseFloat(widget.style.left) || 0,
                    top: parseFloat(widget.style.top) || 0,
                    width: parseFloat(widget.style.width) || 0,
                    height: parseFloat(widget.style.height) || 0
                });
                if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            });
        }

        function isSpotifyEnhancedEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.spotifyEnhanced;
        }

        // Shows/hides the heart button on the player and refreshes the settings panel
        // when the widget is toggled on or off.
        function applySpotifyEnhancedEnabled(enabled) {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (likeBtn) likeBtn.classList.toggle('hidden', !enabled);
            const widget = document.getElementById('spotify-enhanced-widget');
            if (widget) widget.classList.toggle('hidden', !enabled);
            if (enabled) {
                // Sync the heart to whatever is playing right now.
                spotifyEnhancedOnTrackChanged(typeof spotifyCurrentTrack !== 'undefined' ? spotifyCurrentTrack : null);
                renderSpotifyEnhancedWidget();
            } else {
                spotifyEnhancedCurrentSaved = null;
            }
            if (typeof renderSpotifyEnhancedPanel === 'function') renderSpotifyEnhancedPanel();
        }

        // Called by the player widget whenever the current track changes (or clears).
        // Fetches the like-state for the new track and paints the heart accordingly.
        async function spotifyEnhancedOnTrackChanged(track) {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (!isSpotifyEnhancedEnabled()) {
                if (likeBtn) likeBtn.classList.add('hidden');
                return;
            }
            if (likeBtn) likeBtn.classList.remove('hidden');
            spotifyEnhancedCurrentSaved = null;
            paintLikeButton();
            // The queue changes as songs advance — keep the inline strip's Queue tab fresh.
            if (spotifyEwTab === 'queue') renderSpotifyEnhancedWidgetContent();
            if (!track || !track.id || !window.electronAPI?.spotifyIsSaved) return;
            const res = await window.electronAPI.spotifyIsSaved(track.id);
            // Guard against a race: another track may have started while we awaited.
            if (!spotifyCurrentTrack || spotifyCurrentTrack.id !== track.id) return;
            if (res?.ok) {
                spotifyEnhancedCurrentSaved = !!res.saved;
                spotifyEnhancedNeedsReconnect = false;
            } else if (res?.needsReconnect) {
                spotifyEnhancedNeedsReconnect = true;
            }
            paintLikeButton();
        }

        function paintLikeButton() {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (!likeBtn) return;
            const icon = likeBtn.querySelector('i');
            const saved = spotifyEnhancedCurrentSaved === true;
            if (icon) icon.className = `${saved ? 'fas' : 'far'} fa-heart text-[10px]`;
            likeBtn.classList.toggle('is-liked', saved);
            likeBtn.title = saved ? 'Remove from Liked Songs' : 'Add to Liked Songs';
        }

        // Toggles the like-state of the current track from the player's heart button.
        async function spotifyEnhancedToggleLike() {
            if (spotifyEnhancedLikeBusy) return;
            if (!spotifyCurrentTrack || !spotifyCurrentTrack.id) {
                showToast('No track playing', true);
                return;
            }
            if (!window.electronAPI?.spotifySetSaved) return;
            const target = !(spotifyEnhancedCurrentSaved === true);
            spotifyEnhancedLikeBusy = true;
            // Optimistic paint so the heart responds instantly.
            spotifyEnhancedCurrentSaved = target;
            paintLikeButton();
            try {
                const res = await window.electronAPI.spotifySetSaved(spotifyCurrentTrack.id, target);
                if (res?.ok) {
                    showToast(target ? 'Added to Liked Songs' : 'Removed from Liked Songs');
                } else if (res?.needsReconnect) {
                    spotifyEnhancedCurrentSaved = !target; // revert
                    paintLikeButton();
                    spotifyEnhancedNeedsReconnect = true;
                    showToast('Reconnect Spotify to enable liking', true);
                    renderSpotifyEnhancedPanel();
                } else {
                    spotifyEnhancedCurrentSaved = !target; // revert
                    paintLikeButton();
                    showToast('Could not update Liked Songs', true);
                }
            } finally {
                spotifyEnhancedLikeBusy = false;
            }
            // Keep the panel's mirrored heart in sync if it's open.
            renderSpotifyEnhancedPanel();
        }

        function switchSpotifyEnhancedTab(tab) {
            spotifyEnhancedTab = tab;
            renderSpotifyEnhancedPanel();
        }

        function spotifyEnhancedThumb(item) {
            if (item.image) {
                return `<img src="${esc(item.image)}" class="w-9 h-9 rounded-md object-cover shrink-0" onerror="this.style.display='none'">`;
            }
            return `<div class="w-9 h-9 rounded-md bg-neutral-800 flex items-center justify-center shrink-0"><i class="fas fa-music text-[10px] text-neutral-600"></i></div>`;
        }

        function spotifyEnhancedTrackRow(item, opts = {}) {
            const clickable = opts.onclick ? `onclick="${opts.onclick}" title="${esc(opts.title || 'Play')}"` : '';
            const cursor = opts.onclick ? ' cursor-pointer hover:bg-white/5' : '';
            const badge = opts.badge ? `<span class="text-[10px] text-neutral-600 shrink-0 ml-1">${esc(opts.badge)}</span>` : '';
            return `<div class="flex items-center gap-2.5 border border-white/10 rounded-xl p-2${cursor} transition-colors no-drag" ${clickable}>
                ${spotifyEnhancedThumb(item)}
                <div class="min-w-0 flex-1">
                    <p class="text-xs text-neutral-200 truncate">${esc(item.name || '—')}</p>
                    <p class="text-[10px] text-neutral-500 truncate">${esc(item.artist || item.owner || '')}</p>
                </div>
                ${badge}
            </div>`;
        }

        // Renders the full Spotify Enhanced settings panel. Fetches on demand for the
        // active tab so switching tabs / hitting refresh always shows fresh data.
        async function renderSpotifyEnhancedPanel() {
            const panel = document.getElementById('spotify-enhanced-panel');
            if (!panel) return;
            if (!isSpotifyEnhancedEnabled()) { panel.innerHTML = ''; return; }

            // "Draggable panel" toggle — always shown (even before Spotify is
            // connected) so the player strip can be repositioned at any time.
            const dragOn = spotifyEwDraggableEnabled();
            const dragToggle = `<div class="flex items-center justify-between gap-3 border border-white/10 rounded-xl p-3 mt-3">
                <label class="flex items-center gap-3 cursor-pointer min-w-0">
                    <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input" ${dragOn ? 'checked' : ''} onchange="toggleSpotifyEwDraggable(this.checked)"><span class="ios-toggle-track"></span></span>
                    <span class="min-w-0">
                        <span class="text-xs text-neutral-200 block">Draggable panel</span>
                        <span class="text-[10px] text-neutral-600 block">Show a grip on the player strip so you can drag it anywhere. Position is saved per layout.</span>
                    </span>
                </label>
                ${dragOn ? `<button type="button" class="hotkey-bind no-drag shrink-0" onclick="resetSpotifyEwPosition()" title="Reset to default position">Reset</button>` : ''}
            </div>`;

            // Require a Spotify connection for the queue/recent/playlists tabs below.
            let authed = false;
            if (window.electronAPI?.spotifyAuthStatus) {
                const status = await window.electronAPI.spotifyAuthStatus();
                authed = !!status?.authenticated;
            }
            if (!authed) {
                panel.innerHTML = dragToggle + `<p class="text-xs text-neutral-600 mt-3">Connect Spotify in the <span class="text-neutral-400">Spotify Integration</span> section above to use these features.</p>`;
                return;
            }

            const tabs = [
                { id: 'queue', label: 'Queue', icon: 'fa-list-ol' },
                { id: 'recent', label: 'Recent', icon: 'fa-clock-rotate-left' },
                { id: 'playlists', label: 'Playlists', icon: 'fa-list' }
            ];

            const reconnectBanner = spotifyEnhancedNeedsReconnect
                ? `<div class="flex items-center justify-between gap-3 border border-amber-600/40 bg-amber-600/10 rounded-xl p-3 mt-3 mb-2">
                       <span class="text-[11px] text-amber-300">New permissions are needed. Reconnect Spotify to enable queue, playlists, recents & liking.</span>
                       <button type="button" class="hotkey-bind no-drag shrink-0" onclick="connectSpotify()">Reconnect</button>
                   </div>`
                : '';

            const tabBar = `<div class="flex items-center gap-1.5 mt-3 mb-3">
                ${tabs.map(t => `<button type="button" onclick="switchSpotifyEnhancedTab('${t.id}')"
                    class="flex-1 px-2 py-1.5 rounded-lg text-[11px] border transition-colors no-drag ${spotifyEnhancedTab === t.id ? 'bg-white/10 border-white/20 text-white' : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">
                    <i class="fas ${t.icon} mr-1"></i>${t.label}</button>`).join('')}
                <button type="button" onclick="renderSpotifyEnhancedPanel()" title="Refresh"
                    class="w-8 py-1.5 rounded-lg text-[11px] bg-neutral-800/30 border border-neutral-700/50 text-neutral-400 hover:text-neutral-200 transition-colors no-drag"><i class="fas fa-rotate-right"></i></button>
            </div>`;

            panel.innerHTML = dragToggle + reconnectBanner + tabBar +
                `<div id="spotify-enhanced-content"><p class="text-xs text-neutral-600">Loading…</p></div>`;

            const content = document.getElementById('spotify-enhanced-content');
            try {
                if (spotifyEnhancedTab === 'queue') await renderEnhancedQueue(content);
                else if (spotifyEnhancedTab === 'recent') await renderEnhancedRecent(content);
                else await renderEnhancedPlaylists(content);
            } catch (e) {
                if (content) content.innerHTML = `<p class="text-xs text-red-400">Something went wrong loading this.</p>`;
            }
        }

        function enhancedHandleFetchState(res) {
            // Returns an HTML string to show instead of content, or null to proceed.
            if (!res || res.ok !== true) {
                if (res?.needsReconnect) {
                    spotifyEnhancedNeedsReconnect = true;
                    return `<div class="flex items-center justify-between gap-3">
                        <p class="text-xs text-amber-300">Reconnect Spotify to enable this.</p>
                        <button type="button" class="hotkey-bind no-drag" onclick="connectSpotify()">Reconnect</button></div>`;
                }
                return `<p class="text-xs text-neutral-600">Couldn't load — is Spotify playing on a device?</p>`;
            }
            return null;
        }

        async function renderEnhancedQueue(content) {
            if (!window.electronAPI?.spotifyGetQueue) return;
            const res = await window.electronAPI.spotifyGetQueue();
            if (spotifyEnhancedTab !== 'queue' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { content.innerHTML = stateHtml; return; }
            let html = '';
            if (res.nowPlaying) {
                html += `<p class="text-[10px] uppercase tracking-widest text-neutral-600 mb-1.5">Now Playing</p>`;
                html += spotifyEnhancedTrackRow(res.nowPlaying);
            }
            html += `<p class="text-[10px] uppercase tracking-widest text-neutral-600 mt-3 mb-1.5">Up Next</p>`;
            if (!res.queue.length) {
                html += `<p class="text-xs text-neutral-600">Nothing queued.</p>`;
            } else {
                html += `<div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">${res.queue.map(t => spotifyEnhancedTrackRow(t)).join('')}</div>`;
            }
            content.innerHTML = html;
        }

        async function renderEnhancedRecent(content) {
            if (!window.electronAPI?.spotifyRecentlyPlayed) return;
            const res = await window.electronAPI.spotifyRecentlyPlayed();
            if (spotifyEnhancedTab !== 'recent' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { content.innerHTML = stateHtml; return; }
            if (!res.items.length) {
                content.innerHTML = `<p class="text-xs text-neutral-600">No recent tracks yet.</p>`;
                return;
            }
            content.innerHTML = `<div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">${res.items.map(t =>
                spotifyEnhancedTrackRow(t, { onclick: `spotifyEnhancedPlayUri('${esc(t.uri)}')`, title: 'Play' })
            ).join('')}</div>`;
        }

        async function renderEnhancedPlaylists(content) {
            if (!window.electronAPI?.spotifyGetPlaylists) return;
            const res = await window.electronAPI.spotifyGetPlaylists();
            if (spotifyEnhancedTab !== 'playlists' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { content.innerHTML = stateHtml; return; }
            if (!res.items.length) {
                content.innerHTML = `<p class="text-xs text-neutral-600">No playlists found.</p>`;
                return;
            }
            const favs = new Set(spotifyFavPlaylists());
            const sorted = spotifySortPlaylists(res.items);
            const mode = spotifyPlaylistSortMode();
            const header = `<div class="flex items-center justify-between mb-1.5">
                <span class="text-[10px] text-neutral-500">${sorted.length} playlist${sorted.length === 1 ? '' : 's'}</span>
                <button type="button" class="hotkey-bind no-drag" onclick="spotifyToggleSortMode()" title="Toggle sort">Sort: ${mode === 'alpha' ? 'A–Z' : 'Recently opened'}</button>
            </div>`;
            const rows = sorted.map((p) => {
                const on = favs.has(p.id);
                const thumb = p.image
                    ? `<img src="${esc(p.image)}" class="w-9 h-9 rounded-md object-cover shrink-0" onerror="this.style.display='none'">`
                    : `<div class="w-9 h-9 rounded-md bg-neutral-800 flex items-center justify-center shrink-0"><i class="fas fa-music text-[10px] text-neutral-600"></i></div>`;
                return `<div class="flex items-center gap-2 border border-white/10 rounded-xl p-2 cursor-pointer hover:bg-white/5 transition-colors no-drag" onclick="spotifyEnhancedPlayContext('${esc(p.uri)}')" title="Play playlist">
                    <button type="button" onclick="event.stopPropagation(); spotifyToggleFavPlaylist('${esc(p.id)}')" title="${on ? 'Unfavourite' : 'Favourite'}"
                        class="w-6 h-6 flex items-center justify-center shrink-0 ${on ? 'text-amber-400' : 'text-neutral-500'} hover:text-amber-300 transition-colors"><i class="${on ? 'fas' : 'far'} fa-star text-xs"></i></button>
                    ${thumb}
                    <div class="min-w-0 flex-1"><p class="text-xs text-neutral-200 truncate">${esc(p.name)}</p><p class="text-[10px] text-neutral-500 truncate">${esc(p.owner || '')}</p></div>
                    <span class="text-[10px] text-neutral-600 shrink-0">${p.total} tracks</span>
                </div>`;
            }).join('');
            content.innerHTML = header + `<div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">${rows}</div>`;
        }

        async function spotifyEnhancedPlayContext(uri) {
            if (!uri || !window.electronAPI?.spotifyPlayContext) return;
            const res = await window.electronAPI.spotifyPlayContext(uri);
            if (res?.ok) {
                showToast('Playing…');
                // Record for the "recently opened" playlist sort, then refresh views.
                spotifyRecordPlaylistOpened(uri);
                if (spotifyEwTab === 'playlists') renderSpotifyEnhancedWidgetContent();
                setTimeout(() => { if (typeof updateSpotifyWidget === 'function') updateSpotifyWidget(); }, 400);
            } else if (res?.needsReconnect) {
                showToast('Reconnect Spotify to enable this', true);
            } else {
                showToast('Could not start playback — open Spotify on a device first', true);
            }
        }

        async function spotifyEnhancedPlayUri(uri) {
            if (!uri || !window.electronAPI?.spotifyPlayContext) return;
            const res = await window.electronAPI.spotifyPlayContext({ uris: [uri] });
            if (res?.ok) {
                showToast('Playing…');
                setTimeout(() => { if (typeof updateSpotifyWidget === 'function') updateSpotifyWidget(); }, 400);
            } else if (res?.needsReconnect) {
                showToast('Reconnect Spotify to enable this', true);
            } else {
                showToast('Could not start playback — open Spotify on a device first', true);
            }
        }

        // ── Inline player strip (Queue / Recent / Playlists beside the vinyl) ──
        // A very compact mirror of the settings panel, crammed into the upper-right of
        // the player. Same three tabs, same data — just sized for the tiny space.

        function spotifyEwSwitch(tab) {
            spotifyEwTab = tab;
            renderSpotifyEnhancedWidget();
        }

        function renderSpotifyEnhancedWidget() {
            const widget = document.getElementById('spotify-enhanced-widget');
            if (!widget) return;
            if (!isSpotifyEnhancedEnabled()) { widget.classList.add('hidden'); return; }
            widget.classList.remove('hidden');
            initSpotifyEwDrag();
            applySpotifyEwDraggable();
            widget.querySelectorAll('.spotify-ew-tab').forEach((b) => {
                b.classList.toggle('active', b.dataset.ewtab === spotifyEwTab);
            });
            renderSpotifyEnhancedWidgetContent();
        }

        async function renderSpotifyEnhancedWidgetContent() {
            const content = document.getElementById('spotify-ew-content');
            if (!content || !isSpotifyEnhancedEnabled()) return;
            if (!content.innerHTML) content.innerHTML = `<p class="spotify-ew-empty">Loading…</p>`;
            const tab = spotifyEwTab;
            try {
                if (tab === 'queue') await ewRenderQueue(content);
                else if (tab === 'recent') await ewRenderRecent(content);
                else await ewRenderPlaylists(content);
            } catch (e) {
                content.innerHTML = `<p class="spotify-ew-empty">Something went wrong.</p>`;
            }
        }

        function ewStateHtml(res) {
            if (!res || res.ok !== true) {
                if (res?.needsReconnect) return `<button type="button" class="spotify-ew-reconnect" onclick="connectSpotify()">Reconnect Spotify</button>`;
                return `<p class="spotify-ew-empty">Play on a device to see this.</p>`;
            }
            return null;
        }

        function ewThumb(item) {
            if (item.image) return `<img class="spotify-ew-thumb" src="${esc(item.image)}" onerror="this.style.visibility='hidden'">`;
            return `<span class="spotify-ew-thumb" style="display:inline-flex;align-items:center;justify-content:center"><i class="fas fa-music" style="font-size:7px;color:#666"></i></span>`;
        }

        async function ewRenderQueue(content) {
            if (!window.electronAPI?.spotifyGetQueue) return;
            const res = await window.electronAPI.spotifyGetQueue();
            if (spotifyEwTab !== 'queue' || !content) return;
            const s = ewStateHtml(res); if (s) { content.innerHTML = s; return; }
            // Just the upcoming queue — the currently-playing track is already shown
            // on the player itself, so no "Now" row here.
            if (!res.queue.length) { content.innerHTML = `<p class="spotify-ew-empty">Nothing queued.</p>`; return; }
            content.innerHTML = res.queue.map((t) =>
                `<div class="spotify-ew-row" title="${esc(t.name)}">${ewThumb(t)}<span class="spotify-ew-name">${esc(t.name)}</span></div>`
            ).join('');
        }

        async function ewRenderRecent(content) {
            if (!window.electronAPI?.spotifyRecentlyPlayed) return;
            const res = await window.electronAPI.spotifyRecentlyPlayed();
            if (spotifyEwTab !== 'recent' || !content) return;
            const s = ewStateHtml(res); if (s) { content.innerHTML = s; return; }
            if (!res.items.length) { content.innerHTML = `<p class="spotify-ew-empty">Nothing yet.</p>`; return; }
            content.innerHTML = res.items.map((t) =>
                `<div class="spotify-ew-row clickable" onclick="spotifyEnhancedPlayUri('${esc(t.uri)}')" title="${esc(t.name)}">${ewThumb(t)}<span class="spotify-ew-name">${esc(t.name)}</span></div>`
            ).join('');
        }

        async function ewRenderPlaylists(content) {
            if (!window.electronAPI?.spotifyGetPlaylists) return;
            const res = await window.electronAPI.spotifyGetPlaylists();
            if (spotifyEwTab !== 'playlists' || !content) return;
            const s = ewStateHtml(res); if (s) { content.innerHTML = s; return; }
            if (!res.items.length) { content.innerHTML = `<p class="spotify-ew-empty">No playlists.</p>`; return; }
            const favs = new Set(spotifyFavPlaylists());
            const sorted = spotifySortPlaylists(res.items);
            const mode = spotifyPlaylistSortMode();
            let html = `<div class="spotify-ew-sub"><span class="spotify-ew-caption">${sorted.length}</span><button type="button" class="spotify-ew-sort" onclick="spotifyToggleSortMode()" title="Toggle sort">${mode === 'alpha' ? 'A–Z' : 'Recent'} ⇄</button></div>`;
            html += sorted.map((p) => {
                const on = favs.has(p.id);
                return `<div class="spotify-ew-row clickable" onclick="spotifyEnhancedPlayContext('${esc(p.uri)}')" title="${esc(p.name)}">
                    <button type="button" class="spotify-ew-star ${on ? 'on' : ''}" onclick="event.stopPropagation(); spotifyToggleFavPlaylist('${esc(p.id)}')"><i class="${on ? 'fas' : 'far'} fa-star"></i></button>
                    ${ewThumb(p)}
                    <span class="spotify-ew-name">${esc(p.name)}</span>
                </div>`;
            }).join('');
            content.innerHTML = html;
        }
