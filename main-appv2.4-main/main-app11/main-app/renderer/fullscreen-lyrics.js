        // ── Full Screen Lyrics ──────────────────────────────────────────────────
        // An Apple Music–style immersive lyrics stage layered over the whole app
        // window. Enabled via the "Full Screen Lyrics" mini widget (see MINI_WIDGETS
        // in renderer/core.js). When on, a small full-screen button appears in the
        // top-left of the Spotify player — but only while the Lyrics display is also
        // enabled — and opens this stage.
        //
        // This module deliberately does NOT touch the race-sensitive lyric timing in
        // renderer/lyrics.js. It only READS the shared globals that module maintains
        // (spotifyCurrentLyricsDisplay, currentLyricsLineIndex, spotifyCurrentLyrics,
        // lyricsTrackId) via a lightweight requestAnimationFrame follow-loop that runs
        // only while the stage is open, so the compact panel and the full-screen stage
        // stay perfectly in lock-step without any extra timers or reordered awaits.

        // Persisted look preferences (localStorage). Kept tiny + stable.
        //   bg     'album'  blurred album-art backdrop   | 'accent' accent-glow backdrop
        //   layout 'nowplaying' art + progress + lyrics  | 'focus'  centred lyrics only
        const FSL_PREFS_KEY = 'fsLyricsPrefs';
        const FSL_DEFAULT_PREFS = { bg: 'album', layout: 'nowplaying' };

        function getFslPrefs() {
            const raw = (typeof safeParseJSON === 'function')
                ? safeParseJSON(localStorage.getItem(FSL_PREFS_KEY), {})
                : {};
            return {
                bg: raw && (raw.bg === 'accent' || raw.bg === 'album') ? raw.bg : FSL_DEFAULT_PREFS.bg,
                layout: raw && (raw.layout === 'focus' || raw.layout === 'nowplaying') ? raw.layout : FSL_DEFAULT_PREFS.layout,
            };
        }

        function setFslPref(key, value) {
            const prefs = getFslPrefs();
            prefs[key] = value;
            localStorage.setItem(FSL_PREFS_KEY, JSON.stringify(prefs));
            applyFslPrefsToDom();
            if (typeof renderFullscreenLyricsPanel === 'function') renderFullscreenLyricsPanel();
            // Re-centre after a layout change so the active line stays put.
            if (fslOpen) requestAnimationFrame(() => centreFslActiveLine(true));
        }

        function applyFslPrefsToDom() {
            const overlay = document.getElementById('fullscreen-lyrics');
            if (!overlay) return;
            const prefs = getFslPrefs();
            overlay.classList.toggle('fsl-bg-accent', prefs.bg === 'accent');
            overlay.classList.toggle('fsl-layout-focus', prefs.layout === 'focus');
        }

        // ── Availability + player button ────────────────────────────────────────
        // The stage is reachable only when its widget is on AND the Lyrics display is
        // on (there'd be nothing to show otherwise). The compact panel's own visibility
        // is driven by the 'lyricsEnabled' localStorage key (see saveLyricsPrefs).
        function isFullscreenLyricsWidgetEnabled() {
            if (typeof isMiniWidgetEnabled === 'function') return isMiniWidgetEnabled('fullscreenLyrics');
            const prefs = (typeof safeParseJSON === 'function')
                ? safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {}) : {};
            return !!prefs.fullscreenLyrics;
        }

        function isLyricsDisplayEnabled() {
            return localStorage.getItem('lyricsEnabled') !== 'false';
        }

        function canUseFullscreenLyrics() {
            return isFullscreenLyricsWidgetEnabled() && isLyricsDisplayEnabled();
        }

        // Show/hide the top-left full-screen button on the player. Safe to call from
        // anywhere (boot, widget toggle, lyrics toggle) — it just reads current state.
        function updateFullscreenLyricsBtn() {
            const btn = document.getElementById('spotify-lyrics-fullscreen-btn');
            if (!btn) return;
            btn.classList.toggle('is-visible', canUseFullscreenLyrics());
        }

        // Called from applyMiniWidgetPrefs() when the widget toggle flips (and on boot).
        function applyFullscreenLyricsEnabled(enabled) {
            updateFullscreenLyricsBtn();
            if (!enabled && fslOpen) closeFullscreenLyrics();
            if (typeof renderFullscreenLyricsPanel === 'function') renderFullscreenLyricsPanel();
        }

        // ── Open / close ──────────────────────────────────────────────────────────
        let fslOpen = false;
        let fslRafId = null;
        let fslCloseTimer = null;
        let fslBuiltSig = null;   // signature of the lyrics currently built into the DOM
        let fslActiveIdx = -2;    // last highlighted line (-2 = nothing built yet)
        let fslLineEls = [];      // cached .fsl-line elements, index-aligned to display

        function isFullscreenLyricsOpen() { return fslOpen; }

        function openFullscreenLyrics() {
            if (!canUseFullscreenLyrics()) return;
            const overlay = document.getElementById('fullscreen-lyrics');
            if (!overlay) return;

            // If launched from the widget's config panel, the Widget Library is still
            // open beneath us — close it so Escape/back behaviour stays unambiguous
            // (the stage renders above it either way, but stacking two modals is messy).
            const lib = document.getElementById('widget-library-modal');
            if (lib && !lib.classList.contains('hidden') && typeof closeWidgetLibrary === 'function') {
                closeWidgetLibrary();
            }

            if (fslCloseTimer) { clearTimeout(fslCloseTimer); fslCloseTimer = null; }
            overlay.classList.remove('fsl-closing', 'fsl-closing-2', 'hidden');
            overlay.classList.add('shown');
            applyFslPrefsToDom();
            updateFslHeader();
            updateFslProgress();

            // Take the whole app window to true full screen so the stage fills the
            // entire monitor (the overlay is position:fixed and grows with it).
            try { window.electronAPI?.lyricsSetImmersive?.(true); } catch (e) { /* non-fatal */ }

            fslOpen = true;
            fslBuiltSig = null;        // force a fresh build
            fslActiveIdx = -2;
            // Build once the overlay is actually laid out so first-frame measurements
            // (offsetTop / stage height) used for centring are real.
            requestAnimationFrame(() => {
                buildFslLines(true);
                startFslLoop();
                prefetchNextFsl(); // warm the next song's lyrics + art right away
            });
        }

        function closeFullscreenLyrics() {
            const overlay = document.getElementById('fullscreen-lyrics');
            const wasOpen = fslOpen;
            fslOpen = false;
            stopFslLoop();
            const restoreWindow = () => {
                if (wasOpen) { try { window.electronAPI?.lyricsSetImmersive?.(false); } catch (e) { /* non-fatal */ } }
            };
            if (!overlay || overlay.classList.contains('hidden')) { restoreWindow(); return; }
            if (fslCloseTimer) clearTimeout(fslCloseTimer);

            // Phase 1 — collapse the content (art + lyrics settle down/blur out) while
            // the window is STILL full screen and the backdrop stays opaque. This plays
            // the whole exit at full size instead of squishing as the window shrinks.
            overlay.classList.remove('shown');
            overlay.classList.add('fsl-closing');

            fslCloseTimer = setTimeout(() => {
                // Phase 2 — content is gone; the opaque backdrop still covers everything.
                // Restore the window now (it shrinks behind the backdrop → no flash of the
                // stretched dashboard) and fade the whole overlay away to reveal the app.
                restoreWindow();
                overlay.classList.add('fsl-closing-2');
                fslCloseTimer = setTimeout(() => {
                    fslCloseTimer = null;
                    overlay.classList.remove('fsl-closing', 'fsl-closing-2');
                    overlay.classList.add('hidden');
                }, 300);
            }, 400);
        }

        function toggleFullscreenLyrics() {
            if (fslOpen) closeFullscreenLyrics();
            else openFullscreenLyrics();
        }

        // ── Now-playing meta (art + title + artist·album + backdrop) ─────────────
        let fslLastImg = null;
        function updateFslHeader() {
            const track = (typeof spotifyCurrentTrack !== 'undefined') ? spotifyCurrentTrack : null;
            const titleEl = document.getElementById('fsl-title');
            const subEl = document.getElementById('fsl-sub');
            const coverEl = document.getElementById('fsl-cover');
            const backEl = document.getElementById('fsl-backdrop-img');

            const titleText = track?.name || 'Not playing';
            const subText = [track?.artist, track?.album].filter(Boolean).join('  —  ') || '';
            // Use the compact player's shared marquee so long titles/artists scroll on
            // the exact same looping schedule (setMarqueeText + restartMarqueeSchedule
            // are globals from renderer/spotify-widget.js). Falls back to plain text.
            if (typeof setMarqueeText === 'function') {
                if (titleEl) setMarqueeText(titleEl, titleText);
                if (subEl) setMarqueeText(subEl, subText);
                if (typeof restartMarqueeSchedule === 'function') restartMarqueeSchedule();
            } else {
                if (titleEl) titleEl.textContent = titleText;
                if (subEl) subEl.textContent = subText;
            }

            const img = track?.image || '';
            const imgChanged = img !== fslLastImg;
            // Cross-fade the sharp album cover when the track changes (or on first open),
            // instead of popping the new artwork in. On resize (same img) leave it be.
            if (coverEl) {
                if (img && imgChanged) {
                    // Slide the new artwork in from the skip direction (Spotify-style),
                    // once it's decoded so we never flash a blank square.
                    coverEl.style.opacity = '0';
                    coverEl.style.animation = 'none';
                    coverEl.style.setProperty('--fsl-dir', String(fslLastImg == null ? 0 : fslSkipDir));
                    coverEl.onload = () => {
                        coverEl.style.animation = 'none';
                        void coverEl.offsetWidth; // restart the animation cleanly
                        coverEl.style.animation = 'fslCoverIn 0.6s var(--ease-emphasized) forwards';
                    };
                    coverEl.onerror = () => { coverEl.style.opacity = '0'; };
                    coverEl.src = img;
                } else if (img) {
                    coverEl.style.opacity = '1';
                } else {
                    coverEl.style.animation = 'none';
                    coverEl.removeAttribute('src'); coverEl.style.opacity = '0';
                }
            }
            // Backdrop: cross-fade between the two stacked layers so the blurred album
            // wash dissolves into the next song's colours (source art is preloaded, so
            // the incoming layer is already decoded). Opacity is class-driven so the
            // accent-glow mode's `opacity:0 !important` still wins.
            if (imgChanged) {
                const backA = backEl;
                const backB = document.getElementById('fsl-backdrop-img-b');
                if (backA && backB) {
                    const activeLayer = backB.classList.contains('is-active') ? backB : backA;
                    const incoming = activeLayer === backA ? backB : backA;
                    if (img) {
                        if (incoming.getAttribute('src') !== img) incoming.src = img;
                        incoming.classList.add('is-active');
                        activeLayer.classList.remove('is-active');
                    } else {
                        backA.classList.remove('is-active'); backB.classList.remove('is-active');
                        backA.removeAttribute('src'); backB.removeAttribute('src');
                    }
                }
            }
            fslLastImg = img || null;

            // Get ready for the next song (like the default player): warm the lyrics
            // cache and DECODE the upcoming artwork now, so on skip the art slides in
            // instantly instead of decoding on demand.
            if (fslOpen) prefetchNextFsl();
        }

        // Preloads upcoming tracks' album art (kept alive in a small map so it isn't
        // GC'd before use) and nudges the shared lyrics prefetch. Throttled so it
        // doesn't spam the Spotify queue endpoint (which is rate-limited).
        const fslArtPrefetch = new Map(); // url -> HTMLImageElement
        let fslLastArtPrefetch = 0;
        async function prefetchNextFsl() {
            // Lyrics: lyrics.js already prefetches the queue's next tracks into a shared
            // cache; calling it again is safe (it de-dupes) and covers the case where the
            // stage opened between the compact player's prefetch ticks.
            if (typeof prefetchQueuedLyrics === 'function') { try { prefetchQueuedLyrics(); } catch (e) {} }

            const now = Date.now();
            if (now - fslLastArtPrefetch < 4000) return; // throttle queue calls
            fslLastArtPrefetch = now;
            if (!window.electronAPI?.spotifyGetQueue) return;
            try {
                const q = await window.electronAPI.spotifyGetQueue();
                const upcoming = (q?.queue || []).slice(0, 2);
                for (const t of upcoming) {
                    const url = t?.image;
                    if (!url || fslArtPrefetch.has(url)) continue;
                    const im = new Image();
                    im.decoding = 'async';
                    im.src = url; // triggers fetch + decode into the browser cache
                    fslArtPrefetch.set(url, im);
                }
                while (fslArtPrefetch.size > 8) {
                    fslArtPrefetch.delete(fslArtPrefetch.keys().next().value);
                }
            } catch (e) { /* queue unavailable — ignore */ }
        }

        // Mirror the compact player's live progress (width + times) rather than
        // duplicating the interpolation clock — this keeps the two perfectly in sync.
        function updateFslProgress() {
            const fill = document.getElementById('fsl-progress-fill');
            const cur = document.getElementById('fsl-time-current');
            const tot = document.getElementById('fsl-time-total');
            const srcBar = document.getElementById('spotify-progress-bar');
            const srcCur = document.getElementById('spotify-time-current');
            const srcTot = document.getElementById('spotify-time-total');
            // During a skip, keep progress pinned at 0 until the track id actually flips
            // (the compact player is still polling the outgoing track for a moment).
            if (fslSkipHoldTrackId) {
                const curId = (typeof spotifyCurrentTrack !== 'undefined' && spotifyCurrentTrack?.id) || null;
                if (curId && curId !== fslSkipHoldTrackId) {
                    fslSkipHoldTrackId = null; // new track — resume live mirroring below
                } else {
                    if (fill && fill.style.width !== '0%') fill.style.width = '0%';
                    if (cur && cur.textContent !== '0:00') cur.textContent = '0:00';
                    return;
                }
            }
            // Only write when the value actually changed, so the loop doesn't churn
            // the DOM (and force layout) every single frame.
            if (fill && srcBar) { const w = srcBar.style.width || '0%'; if (fill.style.width !== w) fill.style.width = w; }
            if (cur && srcCur) { const t = srcCur.textContent || '0:00'; if (cur.textContent !== t) cur.textContent = t; }
            if (tot && srcTot) { const t = srcTot.textContent || '0:00'; if (tot.textContent !== t) tot.textContent = t; }
        }

        // Click the progress bar to seek (Apple Music–style scrub target).
        function fslSeekFromEvent(event) {
            const bar = document.getElementById('fsl-progress-bar');
            const track = (typeof spotifyCurrentTrack !== 'undefined') ? spotifyCurrentTrack : null;
            if (!bar || !track || !track.duration_ms || typeof spotifySeek !== 'function') return;
            const rect = bar.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            spotifySeek(Math.round(pct * track.duration_ms));
            updateFslProgress();
        }

        // ── Reactive skip: instant on-click feedback ─────────────────────────────
        // The compact player only refreshes ~200ms after a skip (its poll). To feel as
        // reactive as Spotify, the stage responds the INSTANT you hit next/prev: the
        // progress snaps to 0 and the lyric column slides + fades out in the skip
        // direction — then, when the new track's data lands, the artwork slides in from
        // that same direction and the lyrics cascade. fslSkipDir carries the direction.
        let fslSkipDir = 1;         // 1 = next, -1 = previous
        let fslSwapResetTimer = null;
        let fslSkipHoldTrackId = null; // while set, hold progress at 0 (old track still polling)

        function resetFslStageSwap() {
            const stage = document.getElementById('fsl-stage');
            if (stage) { stage.style.transition = ''; stage.style.transform = ''; stage.style.opacity = ''; }
            if (fslSwapResetTimer) { clearTimeout(fslSwapResetTimer); fslSwapResetTimer = null; }
            fslSkipHoldTrackId = null;
        }

        function fslAnticipateSkip(action) {
            if (!fslOpen) return;
            fslSkipDir = action === 'previous' ? -1 : 1;
            const stage = document.getElementById('fsl-stage');
            const fill = document.getElementById('fsl-progress-fill');
            // Hold progress at 0 until the track really changes, so the per-frame mirror
            // can't paint the outgoing track's position back in during the poll gap.
            fslSkipHoldTrackId = (typeof spotifyCurrentTrack !== 'undefined' && spotifyCurrentTrack?.id) || 'hold';
            if (fill) fill.style.width = '0%';           // progress reacts immediately
            if (stage) {
                stage.style.transition = 'opacity 0.18s ease, transform 0.26s var(--ease-in)';
                stage.style.opacity = '0';
                stage.style.transform = `translateX(${-fslSkipDir * 52}px)`;
            }
            // Safety: if the track doesn't actually change (e.g. end of queue), bring the
            // lyrics back rather than leaving them faded out forever.
            if (fslSwapResetTimer) clearTimeout(fslSwapResetTimer);
            fslSwapResetTimer = setTimeout(() => {
                fslSkipHoldTrackId = null;
                if (stage) {
                    stage.style.transition = 'opacity 0.3s ease, transform 0.3s var(--ease-out)';
                    stage.style.opacity = '';
                    stage.style.transform = '';
                }
            }, 1400);
        }

        // ── Build the lyric lines ───────────────────────────────────────────────
        function fslLyricsSignature() {
            const display = (typeof spotifyCurrentLyricsDisplay !== 'undefined') ? spotifyCurrentLyricsDisplay : [];
            const synced = !!(typeof spotifyCurrentLyrics !== 'undefined' && spotifyCurrentLyrics?.synced);
            const tid = (typeof lyricsTrackId !== 'undefined') ? lyricsTrackId : null;
            // The pending/loading state (lyrics null while a track is set) is its own
            // signature so the stage swaps to a spinner between tracks.
            const pending = (typeof spotifyCurrentLyrics !== 'undefined' && spotifyCurrentLyrics == null
                && typeof spotifyCurrentTrack !== 'undefined' && !!spotifyCurrentTrack);
            return `${tid}|${display.length}|${synced ? 1 : 0}|${pending ? 1 : 0}`;
        }

        // Shows one of the empty/loading/no-lyrics states in the dedicated, UN-clipped
        // #fsl-state layer (so the icon's glow is never cut off by the stage mask) and
        // flips the overlay into its "state" mode, which hides the columns.
        //   noTrack → also hides the left now-playing column entirely.
        function renderFslMessage(opts) {
            const overlay = document.getElementById('fullscreen-lyrics');
            const state = document.getElementById('fsl-state');
            if (state) {
                state.innerHTML =
                    `<div class="fsl-state-inner">` +
                        `<div class="fsl-state-badge${opts.spin ? ' is-loading' : ''}"><i class="fas ${opts.icon}"></i></div>` +
                        `<p class="fsl-state-title">${escapeHtml(opts.title)}</p>` +
                        (opts.sub ? `<p class="fsl-state-sub">${escapeHtml(opts.sub)}</p>` : '') +
                    `</div>`;
            }
            if (overlay) {
                overlay.classList.add('fsl-has-state');
                overlay.classList.toggle('fsl-empty', !!opts.noTrack);
            }
            const lines = document.getElementById('fsl-lines');
            if (lines) { lines.innerHTML = ''; lines.style.transform = ''; }
            fslLineEls = [];
        }

        function buildFslLines(force) {
            const container = document.getElementById('fsl-lines');
            if (!container) return;

            const sig = fslLyricsSignature();
            if (!force && sig === fslBuiltSig) return;
            fslBuiltSig = sig;
            fslActiveIdx = -2;
            resetFslStageSwap(); // clear any skip swap-out so the new track's stage is visible

            const track = (typeof spotifyCurrentTrack !== 'undefined') ? spotifyCurrentTrack : null;
            const lyricsObj = (typeof spotifyCurrentLyrics !== 'undefined') ? spotifyCurrentLyrics : null;
            const display = (typeof spotifyCurrentLyricsDisplay !== 'undefined') ? spotifyCurrentLyricsDisplay : [];
            const synced = !!(lyricsObj?.synced);

            // Empty states, mirroring the compact panel's language.
            if (!display.length) {
                if (!track) {
                    renderFslMessage({ icon: 'fa-compact-disc', title: 'Nothing playing', sub: 'Start a song in Spotify and its lyrics will appear here.', noTrack: true });
                } else if (lyricsObj == null) {
                    renderFslMessage({ icon: 'fa-compact-disc', title: 'Finding lyrics…', sub: track.name || '', spin: true });
                } else {
                    renderFslMessage({ icon: 'fa-microphone-slash', title: 'No lyrics found', sub: 'There are no synced lyrics for this track yet.' });
                }
                const stage = document.getElementById('fsl-stage');
                if (stage) stage.classList.remove('fsl-scrollable');
                return;
            }

            const overlay = document.getElementById('fullscreen-lyrics');
            if (overlay) overlay.classList.remove('fsl-has-state', 'fsl-empty');
            container.classList.toggle('fsl-static', !synced);
            container.innerHTML = '';
            fslLineEls = new Array(display.length);

            const frag = document.createDocumentFragment();
            for (let i = 0; i < display.length; i++) {
                const line = display[i];
                const el = document.createElement('div');
                el.className = 'fsl-line';
                el.dataset.idx = String(i);
                el.title = line.text || '';

                const text = line.text || '';
                if (!text.trim()) {
                    // Blank line between verses — render a small "musical rest" dot row
                    // so the gap reads intentionally rather than as empty space.
                    el.classList.add('fsl-line-instrumental');
                    el.innerHTML = '<span class="fsl-rest"></span><span class="fsl-rest"></span><span class="fsl-rest"></span>';
                } else {
                    const parsed = (typeof parseLyricTrailingParens === 'function') ? parseLyricTrailingParens(text) : null;
                    if (parsed) {
                        const main = document.createElement('span');
                        main.className = 'fsl-main-text';
                        main.textContent = parsed.main;
                        const paren = document.createElement('span');
                        paren.className = 'fsl-paren-text';
                        paren.textContent = parsed.secondary;
                        el.appendChild(main);
                        el.appendChild(paren);
                    } else {
                        el.textContent = text;
                    }
                }

                if (synced) el.classList.add('fsl-seekable');
                frag.appendChild(el);
                fslLineEls[i] = el;
            }
            container.appendChild(frag);

            const stage = document.getElementById('fsl-stage');
            if (stage) stage.classList.toggle('fsl-scrollable', !synced);

            // Synced: follow via transform (centred active line). Unsynced: let the
            // stage scroll naturally from the top — there's no active line to chase.
            let anchor = 0;
            if (synced) {
                const idx = (typeof currentLyricsLineIndex !== 'undefined') ? currentLyricsLineIndex : -1;
                setFslActiveLine(idx, true);
                anchor = Math.max(0, idx);
            } else {
                container.style.transform = '';
                if (stage) stage.scrollTop = 0;
            }

            // Cinematic load-in: the lines nearest the anchor rise + un-blur in a
            // quick outward cascade, instead of the whole block appearing at once.
            playFslEntrance(anchor);
        }

        // Staggered per-line reveal used on open / track change. Lines fade + rise +
        // sharpen, delayed by their distance from the anchor so the cascade radiates
        // out from the current line. Uses transitions (not a keyframe with `forwards`)
        // so once it settles, each line falls back to its natural distance-based
        // opacity and the follow-loop's highlighting takes over cleanly.
        let fslEntranceTimer = null;
        function playFslEntrance(anchor) {
            if (!fslLineEls.length) return;
            const base = anchor >= 0 ? anchor : 0;
            const STEP = 42, MAX = 10;
            for (let i = 0; i < fslLineEls.length; i++) {
                const el = fslLineEls[i];
                if (!el) continue;
                const dist = Math.abs(i - base);
                if (dist > MAX) { el.style.transitionDelay = ''; continue; } // off-screen — no reveal
                el.classList.add('fsl-enter');
                el.style.transitionDelay = (dist * STEP) + 'ms';
            }
            // Release next frame so the transitions run from the entered state.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                for (const el of fslLineEls) { if (el) el.classList.remove('fsl-enter'); }
            }));
            // Once the cascade finishes, drop the per-line delays so future single-line
            // advances animate immediately (no inherited stagger).
            clearTimeout(fslEntranceTimer);
            fslEntranceTimer = setTimeout(() => {
                for (const el of fslLineEls) { if (el) el.style.transitionDelay = ''; }
            }, STEP * MAX + 700);
        }

        // ── Highlight + centre the active line ──────────────────────────────────
        function setFslActiveLine(idx, instant) {
            if (idx === fslActiveIdx && !instant) return;
            fslActiveIdx = idx;
            if (!fslLineEls.length) return;

            for (let i = 0; i < fslLineEls.length; i++) {
                const el = fslLineEls[i];
                if (!el) continue;
                const d = idx < 0 ? (i + 1) : Math.abs(i - idx);
                // Distance drives the progressive dim + blur (capped) so far-away lines
                // recede softly, the way Apple Music's stage does.
                el.style.setProperty('--fsl-d', String(Math.min(d, 8)));
                const active = i === idx;
                el.classList.toggle('is-active', active);
                el.classList.toggle('is-past', idx >= 0 && i < idx);
                el.classList.toggle('is-future', idx >= 0 && i > idx);
            }
            centreFslActiveLine(instant);
        }

        function centreFslActiveLine(instant) {
            const container = document.getElementById('fsl-lines');
            const stage = document.getElementById('fsl-stage');
            if (!container || !stage) return;
            if (container.classList.contains('fsl-static')) { container.style.transform = ''; return; }

            const idx = fslActiveIdx;
            const target = (idx >= 0 && fslLineEls[idx]) ? fslLineEls[idx] : fslLineEls[0];
            if (!target) return;

            const centreOfLine = target.offsetTop + target.offsetHeight / 2;
            // Sit the current line a touch ABOVE dead-centre: sung lines fade away above
            // it, so the focus lives in the current + upcoming lines below (teleprompter
            // feel). Before the first line is reached, sit a little higher still.
            const anchor = idx < 0 ? stage.clientHeight * 0.4 : stage.clientHeight * 0.44;
            const y = Math.round(anchor - centreOfLine);

            if (instant) {
                const prev = container.style.transition;
                container.style.transition = 'none';
                container.style.transform = `translate3d(0, ${y}px, 0)`;
                // Force reflow, then restore the smooth transition for subsequent moves.
                void container.offsetHeight;
                container.style.transition = prev || '';
            } else {
                container.style.transform = `translate3d(0, ${y}px, 0)`;
            }
        }

        // ── Follow loop (only while open) ───────────────────────────────────────
        function fslTick() {
            if (!fslOpen) { fslRafId = null; return; }

            updateFslProgress(); // keep the scrub bar + times live

            // Track / lyrics content changed underneath us → rebuild + refresh header.
            const sig = fslLyricsSignature();
            if (sig !== fslBuiltSig) {
                updateFslHeader();
                buildFslLines(true);
            } else {
                // Same lyrics — just chase the active line if it advanced.
                const synced = !!(typeof spotifyCurrentLyrics !== 'undefined' && spotifyCurrentLyrics?.synced);
                if (synced) {
                    const idx = (typeof currentLyricsLineIndex !== 'undefined') ? currentLyricsLineIndex : -1;
                    if (idx !== fslActiveIdx) setFslActiveLine(idx, false);
                }
            }
            fslRafId = requestAnimationFrame(fslTick);
        }

        function startFslLoop() {
            if (fslRafId != null) return;
            fslRafId = requestAnimationFrame(fslTick);
        }

        function stopFslLoop() {
            if (fslRafId != null) { cancelAnimationFrame(fslRafId); fslRafId = null; }
        }

        // Click a line to seek (synced tracks only), reusing the compact panel's seek.
        (function setupFslClickToSeek() {
            const container = document.getElementById('fsl-lines');
            if (!container) return;
            container.addEventListener('click', (event) => {
                const synced = !!(typeof spotifyCurrentLyrics !== 'undefined' && spotifyCurrentLyrics?.synced);
                if (!synced) return;
                const lineEl = event.target.closest('.fsl-line');
                if (!lineEl || !container.contains(lineEl)) return;
                const idx = parseInt(lineEl.dataset.idx, 10);
                if (!Number.isNaN(idx) && typeof seekToLyricsLine === 'function') {
                    event.stopPropagation();
                    seekToLyricsLine(idx);
                }
            });
        })();

        // Re-centre on window resize so the active line never drifts off-centre, and
        // re-measure the title/artist marquee at the new width (the going-fullscreen
        // resize changes the now-playing column's width, so overflow must be re-checked).
        let fslResizeTimer = null;
        window.addEventListener('resize', () => {
            if (!fslOpen) return;
            centreFslActiveLine(true);
            clearTimeout(fslResizeTimer);
            fslResizeTimer = setTimeout(() => { if (fslOpen) updateFslHeader(); }, 160);
        });

        // ── Config panel (Widget Library detail view) ───────────────────────────
        // No-ops unless its div is on screen (only present while the detail is open).
        function renderFullscreenLyricsPanel() {
            const panel = document.getElementById('fullscreen-lyrics-panel');
            if (!panel) return;
            const prefs = getFslPrefs();
            const lyricsOn = isLyricsDisplayEnabled();

            const seg = (group, current, options) => options.map(o =>
                `<button type="button" class="fsl-seg-btn${current === o.value ? ' is-on' : ''} no-drag"` +
                ` onclick="setFslPref('${group}','${o.value}')">` +
                `<i class="fas ${o.icon}"></i><span>${o.label}</span></button>`
            ).join('');

            panel.innerHTML =
                `<div class="fsl-cfg">` +
                    (lyricsOn ? '' :
                        `<div class="fsl-cfg-note"><i class="fas fa-triangle-exclamation"></i>` +
                        `<span>Turn on <b>Show Lyrics display</b> (Settings ▸ Widgets) for the full-screen button to appear on the player.</span></div>`) +
                    `<div class="fsl-cfg-row">` +
                        `<span class="fsl-cfg-label">Backdrop</span>` +
                        `<div class="fsl-seg">` +
                            seg('bg', prefs.bg, [
                                { value: 'album', icon: 'fa-compact-disc', label: 'Album blur' },
                                { value: 'accent', icon: 'fa-droplet', label: 'Accent glow' },
                            ]) +
                        `</div>` +
                    `</div>` +
                    `<div class="fsl-cfg-row">` +
                        `<span class="fsl-cfg-label">Layout</span>` +
                        `<div class="fsl-seg">` +
                            seg('layout', prefs.layout, [
                                { value: 'nowplaying', icon: 'fa-compact-disc', label: 'Now Playing' },
                                { value: 'focus', icon: 'fa-align-center', label: 'Lyrics only' },
                            ]) +
                        `</div>` +
                    `</div>` +
                    `<button type="button" class="fsl-cfg-open no-drag" onclick="openFullscreenLyrics()"` +
                        `${canUseFullscreenLyrics() ? '' : ' disabled'}>` +
                        `<i class="fas fa-up-right-and-down-left-from-center"></i> Open full-screen lyrics` +
                    `</button>` +
                    `<p class="fsl-cfg-hint">Tip: the full-screen button sits in the top-left of the Spotify player. Press <b>Esc</b> to exit the stage.</p>` +
                `</div>`;
        }

        // Wrap the player's skip control so hitting next/previous gives the stage
        // instant feedback (like the default Spotify player) before the new track's
        // data arrives. Same wrapping pattern lyrics.js uses on updateSpotifyWidget;
        // spotify-widget.js loads first, so `spotifyControl` already exists here.
        if (typeof spotifyControl === 'function') {
            const _fslOrigSpotifyControl = spotifyControl;
            spotifyControl = function (action) {
                if (fslOpen && (action === 'next' || action === 'previous')) fslAnticipateSkip(action);
                return _fslOrigSpotifyControl.apply(this, arguments);
            };
        }

        // Keep the player button in sync on first load (widget + lyrics prefs are both
        // read live, so this is safe to call before either apply* function runs).
        updateFullscreenLyricsBtn();
