        // ── Spotify Enhanced mini widget ──
        // Layers a Queue Viewer, Playlist Shortcuts, Recently Played browser and a
        // Like/Unlike control on top of the existing Spotify integration. Everything
        // here is renderer-side; the main process (main/spotify.js) exposes the API
        // calls. When the widget is disabled none of this appears — the heart button
        // on the player stays hidden and the settings panel shows a hint. All the
        // heavy player logic (polling, current track) lives in spotify-widget.js;
        // this file only reads the shared `spotifyCurrentTrack` global from there.

        let spotifyEnhancedTab = 'queue';       // queue | recent | playlists
        let spotifyEnhancedCurrentSaved = null;  // like-state of the current track (null = unknown)
        let spotifyEnhancedNeedsReconnect = false;
        let spotifyEnhancedLikeBusy = false;

        function isSpotifyEnhancedEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.spotifyEnhanced;
        }

        // Shows/hides the heart button on the player and refreshes the settings panel
        // when the widget is toggled on or off.
        function applySpotifyEnhancedEnabled(enabled) {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (likeBtn) likeBtn.classList.toggle('hidden', !enabled);
            if (enabled) {
                // Sync the heart to whatever is playing right now.
                spotifyEnhancedOnTrackChanged(typeof spotifyCurrentTrack !== 'undefined' ? spotifyCurrentTrack : null);
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

            // Require a Spotify connection first.
            let authed = false;
            if (window.electronAPI?.spotifyAuthStatus) {
                const status = await window.electronAPI.spotifyAuthStatus();
                authed = !!status?.authenticated;
            }
            if (!authed) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Connect Spotify in the <span class="text-neutral-400">Spotify Integration</span> section above to use these features.</p>`;
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

            panel.innerHTML = reconnectBanner + tabBar +
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
            content.innerHTML = `<div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">${res.items.map(p =>
                spotifyEnhancedTrackRow(p, { onclick: `spotifyEnhancedPlayContext('${esc(p.uri)}')`, title: 'Play playlist', badge: `${p.total} tracks` })
            ).join('')}</div>`;
        }

        async function spotifyEnhancedPlayContext(uri) {
            if (!uri || !window.electronAPI?.spotifyPlayContext) return;
            const res = await window.electronAPI.spotifyPlayContext(uri);
            if (res?.ok) {
                showToast('Playing…');
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
