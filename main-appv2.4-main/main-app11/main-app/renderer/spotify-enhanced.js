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
        let spotifyStarPopId = null;             // playlist whose star just toggled (plays the pop once)
        let spotifyStarPopTimer = null;
        let spotifyLikeBurstTimer = null;

        const SPOTIFY_ENHANCED_TABS = [
            { id: 'queue', label: 'Queue', icon: 'fa-list-ol' },
            { id: 'recent', label: 'Recent', icon: 'fa-clock-rotate-left' },
            { id: 'playlists', label: 'Playlists', icon: 'fa-list' }
        ];

        function spotifyTabIndex(tab) {
            return Math.max(0, SPOTIFY_ENHANCED_TABS.findIndex((t) => t.id === tab));
        }

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
            // Let this one star pop on the next paint, then forget it so later
            // refreshes don't replay the animation.
            spotifyStarPopId = id;
            clearTimeout(spotifyStarPopTimer);
            spotifyStarPopTimer = setTimeout(() => { spotifyStarPopId = null; }, 1500);
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

        // ── Shared list rendering (strip + settings panel) ──

        // Swaps a list container's markup only when it actually changed, so a
        // background refresh (the queue re-fetches on every track change) neither
        // resets the scroll position nor flickers. A different `key` is a real swap
        // (new tab, new sort order): jump to the top and let the rows cascade in via
        // .spotify-swap. Keys look like "playlists:alpha"; the part before the colon
        // is the tab.
        function spotifySwapContent(el, html, key) {
            if (!el) return;
            el.classList.remove('spotify-busy');
            const switched = el._spotifyKey !== key;
            if (!switched && el._spotifyHtml === html) return;
            // Same tab, new data (the queue moving on): remember where keyed rows and
            // the panel's inner list scroll were, so the update can animate from there.
            const flip = switched ? null : spotifyFlipCapture(el);
            const innerScroll = switched ? 0 : (el.querySelector('.se-scroll')?.scrollTop || 0);
            el._spotifyHtml = html;
            el._spotifyKey = key;
            el.classList.remove('spotify-swap');
            el.innerHTML = html;
            if (switched) {
                el.scrollTop = 0;
                void el.offsetWidth; // restart the cascade
                el.classList.add('spotify-swap');
                return;
            }
            const inner = el.querySelector('.se-scroll');
            if (inner && innerScroll) inner.scrollTop = innerScroll;
            if (flip) spotifyFlipPlay(el, flip);
        }

        // ── Queue motion (FLIP) ──
        // Queue rows carry data-flip keys (track id + occurrence). Before a refresh we
        // record where each keyed row sat; afterwards every row that is still there
        // glides from its old spot to its new one, rows that are new rise in, and rows
        // that left (the song that just started) lift away as a ghost. So when a song
        // starts, the list visibly moves up a slot instead of jumping — and in the
        // settings panel the next song slides up into "Now playing".
        const SPOTIFY_FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

        function spotifyFlipKeys(list, nowPlayingId) {
            const seen = new Map();
            if (nowPlayingId) seen.set(nowPlayingId, 1); // the now-playing row owns ":0"
            return list.map((t) => {
                const n = seen.get(t.id) || 0;
                seen.set(t.id, n + 1);
                return `${t.id}:${n}`;
            });
        }

        function spotifyFlipCapture(el) {
            if (typeof el.animate !== 'function') return null;
            // A hidden window doesn't run animations, so ghosts would pile up and all
            // play at once when it's shown again — just swap the list instead.
            if (document.visibilityState !== 'visible') return null;
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
            const rows = el.querySelectorAll('[data-flip]');
            if (!rows.length) return null;
            const rects = new Map();
            rows.forEach((row) => {
                if (row.classList.contains('is-removing')) return; // already folded away
                rects.set(row.dataset.flip, { rect: row.getBoundingClientRect(), node: row });
            });
            return { base: el.getBoundingClientRect(), rects };
        }

        function spotifyFlipPlay(el, snap) {
            const seen = new Set();
            let entering = 0;
            el.querySelectorAll('[data-flip]').forEach((row) => {
                const key = row.dataset.flip;
                seen.add(key);
                const prev = snap.rects.get(key);
                if (prev) {
                    const dy = prev.rect.top - row.getBoundingClientRect().top;
                    if (Math.abs(dy) < 0.5) return;
                    // A short hold lets the departing ghost clear before rows slide into
                    // its spot, so the two never sit on top of each other.
                    row.animate(
                        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
                        { duration: 480, delay: 70, easing: SPOTIFY_FLIP_EASE, fill: 'backwards' }
                    );
                } else {
                    row.animate(
                        [{ opacity: 0, transform: 'translateY(12px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
                        { duration: 420, delay: 160 + Math.min(entering++, 4) * 60, easing: SPOTIFY_FLIP_EASE, fill: 'backwards' }
                    );
                }
            });
            for (const [key, prev] of snap.rects) {
                if (seen.has(key)) continue;
                const ghost = prev.node.cloneNode(true);
                ghost.removeAttribute('data-flip');
                ghost.classList.add('spotify-flip-ghost');
                ghost.style.top = `${prev.rect.top - snap.base.top + el.scrollTop}px`;
                ghost.style.left = `${prev.rect.left - snap.base.left}px`;
                ghost.style.width = `${prev.rect.width}px`;
                el.appendChild(ghost);
                const anim = ghost.animate(
                    [
                        { opacity: 1, transform: 'none' },
                        { opacity: 0, transform: 'translateY(-10px) scale(0.96)', offset: 0.55 },
                        { opacity: 0, transform: 'translateY(-18px) scale(0.94)' }
                    ],
                    { duration: 300, easing: SPOTIFY_FLIP_EASE, fill: 'forwards' }
                );
                anim.onfinish = () => ghost.remove();
            }
        }

        // Refreshes whichever Queue views are showing.
        let spotifyQueueFollowUp = null;
        let spotifyQueueSettle = null;
        function spotifyRefreshQueueViews() {
            if (spotifyEwTab === 'queue') renderSpotifyEnhancedWidgetContent();
            if (spotifyEnhancedTab === 'queue' && document.getElementById('spotify-enhanced-content')) renderSpotifyEnhancedPanel();
        }

        // Before a fetch: first load shows skeleton rows; switching tabs dims the old
        // list until the new one arrives (never an empty "Loading…" flash).
        function spotifyBeginLoad(el, tab, skeletonHtml) {
            if (!el) return;
            if (!el._spotifyHtml) {
                el.innerHTML = skeletonHtml;
                el._spotifyKey = '__loading';
            } else if (String(el._spotifyKey).split(':')[0] !== tab) {
                el.classList.add('spotify-busy');
            }
        }

        // Album/playlist art with a play glyph that appears on hover when the row is
        // clickable. Falls back to a music note when there's no image.
        function spotifyArt(item, playable) {
            const img = item.image
                ? `<img class="spotify-ew-thumb" src="${esc(item.image)}" alt="" onerror="this.style.visibility='hidden'">`
                : '<i class="fas fa-music"></i>';
            const play = playable ? '<span class="spotify-ew-play"><i class="fas fa-play"></i></span>' : '';
            return `<span class="spotify-ew-thumb-wrap">${img}${play}</span>`;
        }

        function spotifyStar(id, on) {
            const pop = spotifyStarPopId === id ? ' pop' : '';
            return `<button type="button" class="spotify-ew-star${on ? ' on' : ''}${pop} no-drag" onclick="event.stopPropagation(); spotifyToggleFavPlaylist(${jsAttr(id)})" title="${on ? 'Unfavourite' : 'Favourite'}"><i class="${on ? 'fas' : 'far'} fa-star"></i></button>`;
        }

        function spotifyTrackMeta(item) {
            return item.artist || item.owner || '';
        }

        // "12 tracks" — or '' when Spotify didn't send a count, so the UI shows
        // nothing rather than a wrong "0 tracks".
        function spotifyFormatTrackCount(total) {
            return typeof total === 'number' ? `${total} track${total === 1 ? '' : 's'}` : '';
        }

        // Queue rows as Spotify returns them (nulls dropped). Rows with a remove
        // button are about to be on screen, so this also asks main (at most every few
        // minutes) to warm the Spotify app up — its accessibility tree takes a few
        // seconds to build the first time, and that shouldn't land on the first ✕.
        let spotifyDesktopWarmedAt = 0;
        function spotifyVisibleQueue(res) {
            const list = (res.queue || []).filter(Boolean);
            if (list.length && Date.now() - spotifyDesktopWarmedAt > 4 * 60 * 1000 && window.electronAPI?.spotifyDesktopQueueWarm) {
                spotifyDesktopWarmedAt = Date.now();
                window.electronAPI.spotifyDesktopQueueWarm().catch(() => {});
            }
            return list;
        }

        // For each row, which copy of its title it is (0 = first), so the Spotify app
        // can be pointed at the same row when a song is queued more than once.
        function spotifyTitleOccurrences(list) {
            const seen = new Map();
            return list.map((t) => {
                const key = String(t.name || '').trim().toLowerCase();
                const n = seen.get(key) || 0;
                seen.set(key, n + 1);
                return n;
            });
        }

        function spotifyRemoveBtn(track, copy, cls) {
            return `<button type="button" class="${cls} no-drag" onclick="event.stopPropagation(); spotifyQueueRemove(this, ${jsAttr(track.name || '')}, ${jsAttr(copy || 0)})" title="Remove from queue" aria-label="Remove from queue"><i class="fas fa-xmark"></i></button>`;
        }

        const SPOTIFY_REMOVE_ERRORS = {
            unsupported: 'Removing from the queue needs the Spotify app on Windows',
            'not-running': 'Open the Spotify app on this PC to remove songs from the queue',
            'no-window': 'Spotify is closed to the tray — open its window, then try again',
            'not-visible': 'Spotify didn’t show the song’s menu — try again',
            'not-removed': 'Spotify didn’t remove the song — remove it in the Spotify app',
            'no-queue': 'Couldn’t open Spotify’s queue — try again',
            'not-found': 'Couldn’t find that song in Spotify’s queue',
            'no-menu': 'Spotify didn’t open the song’s menu — try again',
            'no-remove-item': 'Spotify didn’t offer “Remove from queue” for that song',
            busy: 'Still removing the last songs…'
        };

        // Spotify's Web API can't remove from the queue, but the Spotify app can: main
        // drives the desktop app to open the song's menu and choose "Remove from
        // queue" — briefly showing Spotify's window (it can't draw the menu otherwise)
        // and putting it back afterwards. The row dims while that happens, then folds
        // away and both queue views refresh from Spotify.
        async function spotifyQueueRemove(btn, title, copy) {
            if (!title || !window.electronAPI?.spotifyDesktopQueueRemove) return;
            const row = btn && btn.closest('.spotify-ew-row, .se-row');
            if (row) row.classList.add('is-pending');
            let res = null;
            try {
                res = await window.electronAPI.spotifyDesktopQueueRemove(title, Number(copy) || 0);
            } catch (e) {
                res = null;
            }
            if (res?.ok) {
                if (row && row.isConnected) {
                    row.style.maxHeight = `${row.offsetHeight}px`;
                    row.classList.remove('is-pending');
                    row.classList.add('is-removing');
                }
                showToast('Removed from queue');
                setTimeout(spotifyRefreshQueueViews, 450);
                setTimeout(spotifyRefreshQueueViews, 2000); // Spotify's queue answer can trail the change
            } else {
                if (row) row.classList.remove('is-pending');
                showToast(SPOTIFY_REMOVE_ERRORS[res?.reason] || 'Couldn’t remove that song from the queue', true);
            }
        }

        // Shows/hides the heart button on the player and refreshes the settings panel
        // when the widget is toggled on or off.
        function applySpotifyEnhancedEnabled(enabled) {
            const widget = document.getElementById('spotify-enhanced-widget');
            if (widget) widget.classList.toggle('hidden', !enabled);
            applySpotifyEwHoverBars();
            applySpotifyModesVisible();
            applySpotifyLikeVisible();
            if (enabled) {
                // Sync the heart to whatever is playing right now.
                spotifyEnhancedOnTrackChanged(typeof spotifyCurrentTrack !== 'undefined' ? spotifyCurrentTrack : null);
                renderSpotifyEnhancedWidget();
            } else {
                spotifyEnhancedCurrentSaved = null;
            }
            if (typeof renderSpotifyEnhancedPanel === 'function') renderSpotifyEnhancedPanel();
        }

        // ── Draggable strip (optional; toggled in Settings) ──
        // When enabled, a grip handle appears at the top of the inline strip and the
        // user can drag it anywhere within the player. Position is remembered
        // separately for the two layout modes — "compact" (Spotify shares the player
        // with other widgets) and "solo" (full-width player) — because the strip has
        // very different default geometry in each, so one saved box wouldn't suit both.
        // In compact mode the strip is collapsible (its size comes from CSS as it
        // opens and closes), so only its position is pinned there, never its size.
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
            clear();
            if (!spotifyEwDraggableEnabled()) return;
            const mode = spotifyEwLayoutMode();
            const box = spotifyEwPositions()[mode];
            if (!box) return;
            widget.style.left = `${box.left}px`;
            widget.style.top = `${box.top}px`;
            widget.style.right = 'auto';
            widget.style.bottom = 'auto';
            if (mode === 'solo') {
                if (box.width) widget.style.width = `${box.width}px`;
                if (box.height) widget.style.height = `${box.height}px`;
            }
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

            let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0, parent = null, mode = 'compact';

            handle.addEventListener('mousedown', (e) => {
                if (!spotifyEwDraggableEnabled()) return;
                e.preventDefault();
                parent = widget.offsetParent || widget.parentElement;
                if (!parent) return;
                mode = spotifyEwLayoutMode();
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
                if (mode === 'solo') {
                    widget.style.width = `${wRect.width}px`;
                    widget.style.height = `${wRect.height}px`;
                }
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
                spotifyEwSavePosition(mode, {
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

        // Called by the player widget whenever the current track changes (or clears).
        // Fetches the like-state for the new track and paints the heart accordingly.
        async function spotifyEnhancedOnTrackChanged(track) {
            applySpotifyLikeVisible();
            // Reset even while this widget is off: the full-screen player's heart
            // reads this state too, and must never show the previous song's.
            spotifyEnhancedCurrentSaved = null;
            if (!isSpotifyEnhancedEnabled()) return;
            paintLikeButton();
            // The queue changes as songs advance — keep both Queue views fresh. Spotify's
            // queue endpoint can lag the track change by a moment, so look again shortly
            // after: an unchanged answer is a no-op, a changed one animates in.
            // Spotify's queue answer right at the change is usually still the old one,
            // and refreshing immediately then again made the rows jump twice. Wait for
            // it to settle, and look once more in case it was slow.
            clearTimeout(spotifyQueueSettle);
            clearTimeout(spotifyQueueFollowUp);
            spotifyQueueSettle = setTimeout(spotifyRefreshQueueViews, 700);
            spotifyQueueFollowUp = setTimeout(spotifyRefreshQueueViews, 2200);
            await spotifyRefreshLiked(track);
        }

        // Asks Spotify whether `track` is in Liked Songs and paints the heart.
        // `force` is the full-screen player, which shows a heart of its own even
        // while this one is switched off.
        async function spotifyRefreshLiked(track, force = false) {
            if (!force && !spotifyLikeEnabled()) return; // the heart is off — don't spend API calls on it
            if (!track || !track.id || !window.electronAPI?.spotifyIsSaved) return;
            const res = await window.electronAPI.spotifyIsSaved(track.id);
            // Guard against races: another track may have started, or the user may
            // have tapped the heart, while we awaited.
            if (!spotifyCurrentTrack || spotifyCurrentTrack.id !== track.id || spotifyEnhancedLikeBusy) return;
            if (res?.ok) {
                spotifyEnhancedCurrentSaved = !!res.saved;
                spotifyEnhancedNeedsReconnect = false;
            } else if (res?.needsReconnect) {
                spotifyEnhancedNeedsReconnect = true;
            }
            paintLikeButton();
        }

        // Liked (or unliked) the song in the Spotify app itself? Re-check when the
        // launcher comes back into focus, so the heart never shows a stale state.
        window.addEventListener('focus', () => {
            if (!isSpotifyEnhancedEnabled() || !spotifyLikeEnabled() || spotifyEnhancedLikeBusy) return;
            const track = typeof spotifyCurrentTrack !== 'undefined' ? spotifyCurrentTrack : null;
            if (track && track.id) spotifyRefreshLiked(track);
        });

        function paintLikeButton() {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (!likeBtn) return;
            const icon = likeBtn.querySelector('i');
            const saved = spotifyEnhancedCurrentSaved === true;
            if (icon) icon.className = `${saved ? 'fas' : 'far'} fa-heart text-[10px]`;
            likeBtn.classList.toggle('is-liked', saved);
            likeBtn.title = saved ? 'Remove from Liked Songs' : 'Add to Liked Songs';
        }

        // The pop + ring only plays when the user likes a track from the button —
        // not when a track that's already liked comes on.
        function playLikeBurst() {
            const likeBtn = document.getElementById('spotify-like-btn');
            if (!likeBtn) return;
            likeBtn.classList.remove('like-burst');
            void likeBtn.offsetWidth;
            likeBtn.classList.add('like-burst');
            clearTimeout(spotifyLikeBurstTimer);
            spotifyLikeBurstTimer = setTimeout(() => likeBtn.classList.remove('like-burst'), 650);
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
            if (target) playLikeBurst();
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

        // ── Settings panel (Widget Library detail) ──
        // Built once as a persistent shell — toggle card, banner slot, segmented tabs,
        // list body — and then only the parts that changed are updated. Rebuilding it
        // wholesale (as it used to) killed the toggle's slide, the tab indicator's
        // glide and flashed "Loading…" on every like/refresh.

        function switchSpotifyEnhancedTab(tab) {
            spotifyEnhancedTab = tab;
            seSyncTabs();
            const content = document.getElementById('spotify-enhanced-content');
            if (content && String(content._spotifyKey).split(':')[0] !== tab) content.classList.add('spotify-busy');
            renderSpotifyEnhancedPanel();
        }

        function seSyncTabs() {
            const tabs = document.querySelector('#spotify-enhanced-panel .se-tabs');
            if (!tabs) return;
            tabs.style.setProperty('--se-i', String(spotifyTabIndex(spotifyEnhancedTab)));
            tabs.querySelectorAll('.se-tab').forEach((b) => {
                const on = b.dataset.setab === spotifyEnhancedTab;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        }

        // Refresh button: spins for at least one turn so a fast reload still reads
        // as "done something".
        async function refreshSpotifyEnhancedPanel() {
            const btn = document.querySelector('#spotify-enhanced-panel .se-icon-btn');
            if (btn) btn.classList.add('spinning');
            const started = Date.now();
            try {
                await renderSpotifyEnhancedPanel();
            } finally {
                setTimeout(() => { if (btn) btn.classList.remove('spinning'); }, Math.max(0, 700 - (Date.now() - started)));
            }
        }

        function seRow(item, i, opts = {}) {
            const click = opts.onclick ? ` onclick="${opts.onclick}" title="${esc(opts.title || 'Play')}"` : '';
            const cls = `se-row spotify-stagger${opts.onclick ? ' clickable' : ''}${opts.cls ? ` ${opts.cls}` : ''}`;
            return `<div class="${cls} no-drag" style="--i:${i}"${opts.flip ? ` data-flip="${esc(opts.flip)}"` : ''}${click}>
                ${opts.lead || ''}${spotifyArt(item, !!opts.onclick)}
                <span class="se-text"><span class="se-name">${esc(item.name || '—')}</span><span class="se-meta">${esc(opts.meta || '')}</span></span>
                ${opts.badge ? `<span class="se-badge">${esc(opts.badge)}</span>` : ''}${opts.trail || ''}
            </div>`;
        }

        function seEmpty(icon, text, extra = '') {
            return `<div class="se-empty spotify-stagger"><i class="fas ${icon}"></i><span>${text}</span>${extra}</div>`;
        }

        function seSkeleton() {
            return `<div class="se-list">${[54, 40, 48, 34].map((w) =>
                `<div class="se-row spotify-ew-skel"><span class="spotify-ew-thumb-wrap"></span><span class="se-text"><span class="spotify-ew-skel-bar" style="width:${w}%"></span><span class="spotify-ew-skel-bar short" style="width:22%"></span></span></div>`
            ).join('')}</div>`;
        }

        // Renders the full Spotify Enhanced settings panel. Fetches on demand for the
        // active tab so switching tabs / hitting refresh always shows fresh data.
        async function renderSpotifyEnhancedPanel() {
            const panel = document.getElementById('spotify-enhanced-panel');
            if (!panel) return;
            if (!isSpotifyEnhancedEnabled()) { panel.innerHTML = ''; return; }

            let shell = panel.querySelector('.se-shell');
            if (!shell) {
                // "Draggable panel" toggle — always shown (even before Spotify is
                // connected) so the player strip can be repositioned at any time.
                panel.innerHTML = `<div class="se-shell">
                    <div class="se-card">
                        <label class="se-card-label">
                            <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input se-drag-toggle" onchange="toggleSpotifyEwDraggable(this.checked)"><span class="ios-toggle-track"></span></span>
                            <span class="min-w-0">
                                <span class="se-card-title">Draggable panel</span>
                                <span class="se-card-sub">Show a grip on the player strip so you can drag it anywhere. Position is saved per layout.</span>
                            </span>
                        </label>
                        <button type="button" class="se-btn se-drag-reset no-drag" onclick="resetSpotifyEwPosition()" title="Reset to default position"><i class="fas fa-rotate-left"></i>Reset</button>
                    </div>
                    <div class="se-card">
                        <label class="se-card-label">
                            <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input se-hover-toggle" onchange="toggleSpotifyEwHoverBars(this.checked)"><span class="ios-toggle-track"></span></span>
                            <span class="min-w-0">
                                <span class="se-card-title">Hover bars</span>
                                <span class="se-card-sub">Tuck the panel away behind two thin bars beside the volume slider. Hover the bars to slide it out.</span>
                            </span>
                        </label>
                    </div>
                    <div class="se-card">
                        <label class="se-card-label">
                            <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input se-modes-toggle" onchange="toggleSpotifyModes(this.checked)"><span class="ios-toggle-track"></span></span>
                            <span class="min-w-0">
                                <span class="se-card-title">Loop &amp; shuffle</span>
                                <span class="se-card-sub">Show shuffle and repeat buttons on the player. Repeat cycles off → all → this song.</span>
                            </span>
                        </label>
                    </div>
                    <div class="se-card">
                        <label class="se-card-label">
                            <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input se-like-toggle" onchange="toggleSpotifyLike(this.checked)"><span class="ios-toggle-track"></span></span>
                            <span class="min-w-0">
                                <span class="se-card-title">Like button</span>
                                <span class="se-card-sub">Hover the song title on the player to pop out a heart beside it. It fills in when the song is already in your Liked Songs.</span>
                            </span>
                        </label>
                    </div>
                    <div class="se-banner-slot"></div>
                    <div class="se-main"></div>
                </div>`;
                shell = panel.querySelector('.se-shell');
            }

            const dragOn = spotifyEwDraggableEnabled();
            const toggle = shell.querySelector('.se-drag-toggle');
            if (toggle && toggle.checked !== dragOn) toggle.checked = dragOn;
            shell.querySelector('.se-drag-reset')?.classList.toggle('is-off', !dragOn);
            const hoverToggle = shell.querySelector('.se-hover-toggle');
            if (hoverToggle && hoverToggle.checked !== spotifyEwHoverBarsEnabled()) hoverToggle.checked = spotifyEwHoverBarsEnabled();
            const modesToggle = shell.querySelector('.se-modes-toggle');
            if (modesToggle && modesToggle.checked !== spotifyModesEnabled()) modesToggle.checked = spotifyModesEnabled();
            const likeToggle = shell.querySelector('.se-like-toggle');
            if (likeToggle && likeToggle.checked !== spotifyLikeEnabled()) likeToggle.checked = spotifyLikeEnabled();

            // Require a Spotify connection for the queue/recent/playlists tabs below.
            let authed = false;
            if (window.electronAPI?.spotifyAuthStatus) {
                const status = await window.electronAPI.spotifyAuthStatus();
                authed = !!status?.authenticated;
            }
            if (!shell.isConnected) return; // detail closed while we waited

            const bannerSlot = shell.querySelector('.se-banner-slot');
            const main = shell.querySelector('.se-main');
            if (!authed) {
                bannerSlot.innerHTML = '';
                bannerSlot._html = '';
                if (main.dataset.state !== 'unauthed') {
                    main.dataset.state = 'unauthed';
                    main.innerHTML = `<p class="se-hint">Connect Spotify in the <b>Spotify Integration</b> section above to use these features.</p>`;
                }
                return;
            }

            const bannerHtml = spotifyEnhancedNeedsReconnect
                ? `<div class="se-banner">
                       <span>New permissions are needed. Reconnect Spotify to enable queue, playlists, recents &amp; liking.</span>
                       <button type="button" class="se-btn se-btn-warn no-drag" onclick="connectSpotify()">Reconnect</button>
                   </div>`
                : '';
            if (bannerSlot._html !== bannerHtml) {
                bannerSlot._html = bannerHtml;
                bannerSlot.innerHTML = bannerHtml;
            }

            if (main.dataset.state !== 'authed') {
                main.dataset.state = 'authed';
                main.innerHTML = `<div class="se-toolbar">
                        <div class="se-tabs" role="tablist">
                            ${SPOTIFY_ENHANCED_TABS.map((t) => `<button type="button" role="tab" class="se-tab no-drag" data-setab="${t.id}" onclick="switchSpotifyEnhancedTab(${jsAttr(t.id)})"><i class="fas ${t.icon}"></i>${t.label}</button>`).join('')}
                        </div>
                        <button type="button" class="se-icon-btn no-drag" onclick="refreshSpotifyEnhancedPanel()" title="Refresh"><i class="fas fa-rotate-right"></i></button>
                    </div>
                    <div id="spotify-enhanced-content" class="se-body"></div>`;
            }
            seSyncTabs();

            const content = document.getElementById('spotify-enhanced-content');
            const tab = spotifyEnhancedTab;
            spotifyBeginLoad(content, tab, seSkeleton());
            try {
                if (tab === 'queue') await renderEnhancedQueue(content);
                else if (tab === 'recent') await renderEnhancedRecent(content);
                else await renderEnhancedPlaylists(content);
            } catch (e) {
                if (spotifyEnhancedTab === tab) spotifySwapContent(content, seEmpty('fa-triangle-exclamation', 'Something went wrong loading this.'), tab);
            }
        }

        function enhancedHandleFetchState(res) {
            // Returns an HTML string to show instead of content, or null to proceed.
            if (!res || res.ok !== true) {
                if (res?.needsReconnect) {
                    spotifyEnhancedNeedsReconnect = true;
                    return seEmpty('fa-plug-circle-exclamation', 'Reconnect Spotify to enable this.',
                        `<button type="button" class="se-btn se-btn-warn no-drag" onclick="connectSpotify()">Reconnect</button>`);
                }
                return seEmpty('fa-headphones', 'Couldn’t load — is Spotify playing on a device?');
            }
            return null;
        }

        async function renderEnhancedQueue(content) {
            if (!window.electronAPI?.spotifyGetQueue) return;
            const res = await window.electronAPI.spotifyGetQueue();
            if (spotifyEnhancedTab !== 'queue' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { spotifySwapContent(content, stateHtml, 'queue'); return; }
            let html = '';
            if (res.nowPlaying) {
                const paused = typeof spotifyIsPlaying !== 'undefined' && !spotifyIsPlaying;
                html += `<div class="se-head spotify-stagger" style="--i:0"><span class="se-label"><span class="se-eq${paused ? ' paused' : ''}"><span></span><span></span><span></span></span>Now playing</span></div>`;
                html += seRow(res.nowPlaying, 1, { cls: 'se-now', meta: spotifyTrackMeta(res.nowPlaying), flip: `${res.nowPlaying.id}:0` });
            }
            const queue = spotifyVisibleQueue(res);
            const keys = spotifyFlipKeys(queue, res.nowPlaying?.id);
            const copies = spotifyTitleOccurrences(queue);
            const n = queue.length;
            html += `<div class="se-head spotify-stagger" style="--i:2"><span class="se-label">Up next</span>${n ? `<span class="se-badge">${spotifyFormatTrackCount(n)}</span>` : ''}</div>`;
            html += !n
                ? seEmpty('fa-list-ol', 'Nothing queued.')
                : `<div class="se-list se-scroll">${queue.map((t, i) => seRow(t, i + 3, {
                    lead: `<span class="se-index">${i + 1}</span>`,
                    meta: spotifyTrackMeta(t),
                    trail: spotifyRemoveBtn(t, copies[i], 'se-remove'),
                    flip: keys[i]
                })).join('')}</div>`;
            spotifySwapContent(content, html, 'queue');
        }

        async function renderEnhancedRecent(content) {
            if (!window.electronAPI?.spotifyRecentlyPlayed) return;
            const res = await window.electronAPI.spotifyRecentlyPlayed();
            if (spotifyEnhancedTab !== 'recent' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { spotifySwapContent(content, stateHtml, 'recent'); return; }
            if (!res.items.length) {
                spotifySwapContent(content, seEmpty('fa-clock-rotate-left', 'No recent tracks yet.'), 'recent');
                return;
            }
            const html = `<div class="se-head spotify-stagger" style="--i:0"><span class="se-label">Recently played</span><span class="se-badge">Click a track to play it</span></div>
                <div class="se-list se-scroll">${res.items.map((t, i) =>
                    seRow(t, i + 1, { onclick: `spotifyEnhancedPlayUri(${jsAttr(t.uri)}, ${jsAttr(t.contextUri || null)})`, title: 'Play', meta: spotifyTrackMeta(t) })
                ).join('')}</div>`;
            spotifySwapContent(content, html, 'recent');
        }

        async function renderEnhancedPlaylists(content) {
            if (!window.electronAPI?.spotifyGetPlaylists) return;
            const res = await window.electronAPI.spotifyGetPlaylists();
            if (spotifyEnhancedTab !== 'playlists' || !content) return;
            const stateHtml = enhancedHandleFetchState(res);
            if (stateHtml) { spotifySwapContent(content, stateHtml, 'playlists'); return; }
            if (!res.items.length) {
                spotifySwapContent(content, seEmpty('fa-list', 'No playlists found.'), 'playlists');
                return;
            }
            const favs = new Set(spotifyFavPlaylists());
            const sorted = spotifySortPlaylists(res.items);
            const mode = spotifyPlaylistSortMode();
            const header = `<div class="se-head spotify-stagger" style="--i:0">
                <span class="se-label">${sorted.length} playlist${sorted.length === 1 ? '' : 's'}</span>
                <button type="button" class="se-btn no-drag" onclick="spotifyToggleSortMode()" title="Toggle sort"><i class="fas ${mode === 'alpha' ? 'fa-arrow-down-a-z' : 'fa-clock-rotate-left'}"></i>${mode === 'alpha' ? 'A–Z' : 'Recently opened'}</button>
            </div>`;
            const rows = sorted.map((p, i) => seRow(p, i + 1, {
                onclick: `spotifyEnhancedPlayContext(${jsAttr(p.uri)})`,
                title: 'Play playlist',
                lead: spotifyStar(p.id, favs.has(p.id)),
                meta: p.owner || '',
                badge: spotifyFormatTrackCount(p.total)
            })).join('');
            spotifySwapContent(content, `${header}<div class="se-list se-scroll">${rows}</div>`, `playlists:${mode}`);
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
            } else if (res?.notApplied) {
                showToast('Spotify didn’t switch songs — try pressing play in Spotify once, then again here', true);
            } else if (res?.restricted) {
                showToast('Spotify won’t play that here — Premium may be required', true);
            } else {
                showToast('Could not start playback — open Spotify on a device first', true);
            }
        }

        // contextUri (optional) is the album/playlist the track was played from, so
        // playback carries on from there instead of stopping after this one song.
        async function spotifyEnhancedPlayUri(uri, contextUri) {
            if (!window.electronAPI?.spotifyPlayContext) return;
            if (!uri) { showToast('That song has no Spotify link to play', true); return; }
            const res = await window.electronAPI.spotifyPlayContext(contextUri ? { contextUri, offsetUri: uri } : { uris: [uri] });
            if (res?.ok) {
                showToast('Playing…');
                setTimeout(() => { if (typeof updateSpotifyWidget === 'function') updateSpotifyWidget(); }, 400);
            } else if (res?.needsReconnect) {
                showToast('Reconnect Spotify to enable this', true);
            } else if (res?.notApplied) {
                showToast('Spotify didn’t switch songs — try pressing play in Spotify once, then again here', true);
            } else if (res?.restricted) {
                showToast('Spotify won’t play that here — Premium may be required', true);
            } else {
                showToast('Could not start playback — open Spotify on a device first', true);
            }
        }

        // ── Inline player strip (Queue / Recent / Playlists beside the vinyl) ──
        // A compact mirror of the settings panel. In the 3-widget row it rests as a
        // small button and unfolds on hover (CSS); when Spotify has the row to itself
        // (.spotify-solo) it stays open beside the disc.

        function spotifyEwSwitch(tab) {
            spotifyEwTab = tab;
            renderSpotifyEnhancedWidget();
        }

        // Click/tap on the collapsed button opens the strip without needing hover;
        // mouseleave (inline on the element) closes it again.
        function spotifyEwPeek() {
            document.getElementById('spotify-enhanced-widget')?.classList.toggle('ew-open');
        }

        // ── Hover bars (optional; Settings → "Hover bars") ──
        // Two thin bars beside the volume slider; the panel stays tucked away until
        // they're hovered. All the showing and hiding is CSS (:has on #spotify-active),
        // this only switches the mode on and off.
        function spotifyEwHoverBarsEnabled() {
            return localStorage.getItem('spotifyEwHoverBars') === '1';
        }
        function applySpotifyEwHoverBars() {
            const on = isSpotifyEnhancedEnabled() && spotifyEwHoverBarsEnabled();
            document.getElementById('spotify-active')?.classList.toggle('ew-hover-mode', on);
        }
        function toggleSpotifyEwHoverBars(on) {
            localStorage.setItem('spotifyEwHoverBars', on ? '1' : '0');
            applySpotifyEwHoverBars();
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            renderSpotifyEnhancedPanel();
        }

        // ── Loop & shuffle buttons (optional; Settings → "Loop & shuffle") ──
        const SPOTIFY_REPEAT_ORDER = ['off', 'context', 'track'];   // Spotify's own cycle
        const SPOTIFY_REPEAT_TITLES = { off: 'Repeat: off', context: 'Repeat: all', track: 'Repeat: this song' };
        let spotifyModeState = { shuffle: false, repeat: 'off' };
        // Spotify's player state lags a toggle by a poll or two; ignore polled modes
        // for a moment after a click so the button doesn't flick back and forth.
        let spotifyModeHoldUntil = 0;

        function spotifyModesEnabled() {
            return localStorage.getItem('spotifyShowLoopShuffle') === '1';
        }
        function applySpotifyModesVisible() {
            const on = isSpotifyEnhancedEnabled() && spotifyModesEnabled();
            document.getElementById('spotify-shuffle-btn')?.classList.toggle('hidden', !on);
            document.getElementById('spotify-repeat-btn')?.classList.toggle('hidden', !on);
            document.getElementById('spotify-controls')?.classList.toggle('spotify-modes-on', on);
            if (on) paintSpotifyModes();
        }
        function toggleSpotifyModes(on) {
            localStorage.setItem('spotifyShowLoopShuffle', on ? '1' : '0');
            applySpotifyModesVisible();
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            renderSpotifyEnhancedPanel();
        }
        function paintSpotifyModes() {
            const sh = document.getElementById('spotify-shuffle-btn');
            if (sh) {
                sh.classList.toggle('is-on', spotifyModeState.shuffle);
                sh.title = spotifyModeState.shuffle ? 'Shuffle: on' : 'Shuffle: off';
                sh.setAttribute('aria-pressed', spotifyModeState.shuffle ? 'true' : 'false');
            }
            const rp = document.getElementById('spotify-repeat-btn');
            if (rp) {
                rp.classList.toggle('is-on', spotifyModeState.repeat !== 'off');
                rp.classList.toggle('is-track', spotifyModeState.repeat === 'track');
                rp.title = SPOTIFY_REPEAT_TITLES[spotifyModeState.repeat] || 'Repeat';
            }
        }
        // Called by spotify-widget.js on every poll with the player state.
        function spotifyEnhancedOnPlayback(data) {
            if (!data || Date.now() < spotifyModeHoldUntil) return;
            if (typeof data.shuffle_state === 'boolean') spotifyModeState.shuffle = data.shuffle_state;
            if (SPOTIFY_REPEAT_ORDER.includes(data.repeat_state)) spotifyModeState.repeat = data.repeat_state;
            if (spotifyModesEnabled()) paintSpotifyModes();
        }
        function spotifyModePop(id) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.remove('mode-pop');
            void btn.offsetWidth;
            btn.classList.add('mode-pop');
        }
        // Optimistic: paint first, then ask Spotify; put it back if Spotify says no.
        async function spotifySetMode(patch, action, failText) {
            const prev = { ...spotifyModeState };
            spotifyModeState = { ...spotifyModeState, ...patch };
            spotifyModeHoldUntil = Date.now() + 4000;
            paintSpotifyModes();
            const res = window.electronAPI?.spotifyControl ? await window.electronAPI.spotifyControl(action) : null;
            if (!res?.success) {
                spotifyModeState = prev;
                spotifyModeHoldUntil = 0;
                paintSpotifyModes();
                if (typeof showToast === 'function') showToast(failText, true);
                return false;
            }
            return true;
        }
        async function spotifyToggleShuffle() {
            const on = !spotifyModeState.shuffle;
            spotifyModePop('spotify-shuffle-btn');
            const ok = await spotifySetMode({ shuffle: on }, on ? 'shuffle-on' : 'shuffle-off',
                'Couldn’t change shuffle — is Spotify playing on a device?');
            // Shuffling reorders what's up next.
            if (ok) setTimeout(spotifyRefreshQueueViews, 700);
        }
        function spotifyCycleRepeat() {
            const next = SPOTIFY_REPEAT_ORDER[(SPOTIFY_REPEAT_ORDER.indexOf(spotifyModeState.repeat) + 1) % SPOTIFY_REPEAT_ORDER.length];
            spotifyModePop('spotify-repeat-btn');
            spotifySetMode({ repeat: next }, `repeat-${next}`, 'Couldn’t change repeat — is Spotify playing on a device?');
        }

        // ── Like button (optional; Settings → "Like button", off by default) ──
        // Hover the song title on the player and a heart pops out to its right. While
        // it's off the heart is hidden and like-state is never fetched.
        function spotifyLikeEnabled() {
            return localStorage.getItem('spotifyLikeOnHover') === '1';
        }
        function applySpotifyLikeVisible() {
            const on = isSpotifyEnhancedEnabled() && spotifyLikeEnabled();
            document.getElementById('spotify-like-btn')?.classList.toggle('hidden', !on);
            document.querySelector('.spotify-track-info')?.classList.toggle('has-like', on);
        }
        function toggleSpotifyLike(on) {
            localStorage.setItem('spotifyLikeOnHover', on ? '1' : '0');
            applySpotifyLikeVisible();
            const track = typeof spotifyCurrentTrack !== 'undefined' ? spotifyCurrentTrack : null;
            if (on && track) spotifyRefreshLiked(track);
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            renderSpotifyEnhancedPanel();
        }

        function renderSpotifyEnhancedWidget() {
            const widget = document.getElementById('spotify-enhanced-widget');
            if (!widget) return;
            if (!isSpotifyEnhancedEnabled()) { widget.classList.add('hidden'); return; }
            widget.classList.remove('hidden');
            initSpotifyEwDrag();
            applySpotifyEwDraggable();
            applySpotifyEwHoverBars();
            applySpotifyModesVisible();
            applySpotifyLikeVisible();
            const tabs = widget.querySelector('.spotify-ew-tabs');
            if (tabs) tabs.style.setProperty('--ew-i', String(spotifyTabIndex(spotifyEwTab)));
            widget.querySelectorAll('.spotify-ew-tab').forEach((b) => {
                const on = b.dataset.ewtab === spotifyEwTab;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            // The collapsed button wears the active tab's icon.
            const peekIcon = widget.querySelector('.spotify-ew-peek i');
            const active = SPOTIFY_ENHANCED_TABS[spotifyTabIndex(spotifyEwTab)];
            if (peekIcon && active) peekIcon.className = `fas ${active.icon}`;
            renderSpotifyEnhancedWidgetContent();
        }

        async function renderSpotifyEnhancedWidgetContent() {
            const content = document.getElementById('spotify-ew-content');
            if (!content || !isSpotifyEnhancedEnabled()) return;
            const tab = spotifyEwTab;
            spotifyBeginLoad(content, tab, ewSkeleton());
            try {
                if (tab === 'queue') await ewRenderQueue(content);
                else if (tab === 'recent') await ewRenderRecent(content);
                else await ewRenderPlaylists(content);
            } catch (e) {
                if (spotifyEwTab === tab) spotifySwapContent(content, ewEmpty('fa-triangle-exclamation', 'Something went wrong'), tab);
            }
        }

        function ewRow(item, i, opts = {}) {
            const click = opts.onclick ? ` onclick="${opts.onclick}"` : '';
            const title = opts.meta ? `${item.name || ''} — ${opts.meta}` : (item.name || '');
            return `<div class="spotify-ew-row spotify-stagger${opts.onclick ? ' clickable' : ''} no-drag" style="--i:${i}"${opts.flip ? ` data-flip="${esc(opts.flip)}"` : ''}${click} title="${esc(title)}">
                ${opts.lead || ''}${spotifyArt(item, !!opts.onclick)}
                <span class="spotify-ew-text"><span class="spotify-ew-name">${esc(item.name || '—')}</span>${opts.meta ? `<span class="spotify-ew-meta">${esc(opts.meta)}</span>` : ''}</span>${opts.trail || ''}
            </div>`;
        }

        function ewEmpty(icon, text, extra = '') {
            return `<div class="spotify-ew-empty spotify-stagger"><i class="fas ${icon}"></i><span>${text}</span>${extra}</div>`;
        }

        function ewSkeleton() {
            return [76, 58, 68, 50].map((w) =>
                `<div class="spotify-ew-row spotify-ew-skel"><span class="spotify-ew-thumb-wrap"></span><span class="spotify-ew-text"><span class="spotify-ew-skel-bar" style="width:${w}%"></span><span class="spotify-ew-skel-bar short"></span></span></div>`
            ).join('');
        }

        function ewStateHtml(res) {
            if (!res || res.ok !== true) {
                if (res?.needsReconnect) {
                    return ewEmpty('fa-plug-circle-exclamation', 'Needs new permissions',
                        `<button type="button" class="spotify-ew-reconnect no-drag" onclick="connectSpotify()">Reconnect</button>`);
                }
                return ewEmpty('fa-headphones', 'Play on a device to see this');
            }
            return null;
        }

        async function ewRenderQueue(content) {
            if (!window.electronAPI?.spotifyGetQueue) return;
            const res = await window.electronAPI.spotifyGetQueue();
            if (spotifyEwTab !== 'queue' || !content) return;
            const s = ewStateHtml(res); if (s) { spotifySwapContent(content, s, 'queue'); return; }
            // Just the upcoming queue — the currently-playing track is already shown
            // on the player itself, so no "Now" row here.
            const queue = spotifyVisibleQueue(res);
            const keys = spotifyFlipKeys(queue);
            const copies = spotifyTitleOccurrences(queue);
            if (!queue.length) { spotifySwapContent(content, ewEmpty('fa-list-ol', 'Nothing queued'), 'queue'); return; }
            spotifySwapContent(content, queue.map((t, i) => ewRow(t, i, {
                lead: `<span class="spotify-ew-index">${i + 1}</span>`,
                meta: spotifyTrackMeta(t),
                trail: spotifyRemoveBtn(t, copies[i], 'spotify-ew-remove'),
                flip: keys[i]
            })).join(''), 'queue');
        }

        async function ewRenderRecent(content) {
            if (!window.electronAPI?.spotifyRecentlyPlayed) return;
            const res = await window.electronAPI.spotifyRecentlyPlayed();
            if (spotifyEwTab !== 'recent' || !content) return;
            const s = ewStateHtml(res); if (s) { spotifySwapContent(content, s, 'recent'); return; }
            if (!res.items.length) { spotifySwapContent(content, ewEmpty('fa-clock-rotate-left', 'Nothing yet'), 'recent'); return; }
            spotifySwapContent(content, res.items.map((t, i) => ewRow(t, i, {
                onclick: `spotifyEnhancedPlayUri(${jsAttr(t.uri)}, ${jsAttr(t.contextUri || null)})`,
                meta: spotifyTrackMeta(t)
            })).join(''), 'recent');
        }

        async function ewRenderPlaylists(content) {
            if (!window.electronAPI?.spotifyGetPlaylists) return;
            const res = await window.electronAPI.spotifyGetPlaylists();
            if (spotifyEwTab !== 'playlists' || !content) return;
            const s = ewStateHtml(res); if (s) { spotifySwapContent(content, s, 'playlists'); return; }
            if (!res.items.length) { spotifySwapContent(content, ewEmpty('fa-list', 'No playlists'), 'playlists'); return; }
            const favs = new Set(spotifyFavPlaylists());
            const sorted = spotifySortPlaylists(res.items);
            const mode = spotifyPlaylistSortMode();
            let html = `<div class="spotify-ew-sub spotify-stagger"><span class="spotify-ew-caption">${sorted.length} playlist${sorted.length === 1 ? '' : 's'}</span><button type="button" class="spotify-ew-sort no-drag" onclick="spotifyToggleSortMode()" title="Toggle sort"><i class="fas ${mode === 'alpha' ? 'fa-arrow-down-a-z' : 'fa-clock-rotate-left'}"></i>${mode === 'alpha' ? 'A–Z' : 'Recent'}</button></div>`;
            html += sorted.map((p, i) => ewRow(p, i + 1, {
                onclick: `spotifyEnhancedPlayContext(${jsAttr(p.uri)})`,
                lead: spotifyStar(p.id, favs.has(p.id)),
                meta: spotifyFormatTrackCount(p.total) || p.owner || ''
            })).join('');
            spotifySwapContent(content, html, `playlists:${mode}`);
        }
