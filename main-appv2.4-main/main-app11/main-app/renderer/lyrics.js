        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        let spotifyCurrentLyrics = null;
        let spotifyCurrentLyricsDisplay = []; // [{ time: ms|null, text }, ...]
        let currentLyricsLineIndex = -1;
        let lyricsTrackId = null;       // which track's lyrics are currently loaded
        let lyricsRequestSeq = 0;       // guards against stale fetches from rapid track skips

        // Local high-resolution playback clock, used to interpolate between
        // Spotify's ~1s polling interval so the highlighted line updates smoothly
        // and lands close to the real moment instead of up to 1s late.
        let lyricsLastKnownProgressMs = 0;
        let lyricsLastKnownProgressAt = 0;

        // lrclib's timestamps mark the moment each line is actually sung. Showing the
        // line exactly then reads as "late" by the time you notice it, so every line is
        // surfaced some ms before its source timestamp instead. The amount is now a
        // user setting (see getLyricsAnticipateMs / the "Lyrics Timing" slider above).
        function lyricsEffectiveTime(t) {
            return t == null ? null : Math.max(0, t - getLyricsAnticipateMs());
        }

        // ── Compact panel "conveyor" renderer ──
        // Shows the current line plus upcoming lines stacked below it. When playback
        // advances to the next line: the old current line slides up and fades out,
        // every other visible line pulls up into its new slot, and a fresh upcoming
        // line fades + pulls in at the bottom — instead of just swapping text in place.
        // Real lyric lines are laid out by MEASURED height (see layoutLyricsSlots) so a
        // line that wraps to two or three visual rows — or a line split into a main +
        // trailing-paren line — never overlaps the line below it. LYRICS_ROW_HEIGHT is
        // only a fallback stride (used before a line has been measured) and the fixed
        // stride for the loading skeleton bars, which are all the same tiny height.
        const LYRICS_ROW_HEIGHT = 44;  // px fallback/skeleton stride
        const LYRICS_GAP = 14;         // px vertical gap between consecutive measured lyric lines
        const LYRICS_TOP_PAD = 26;     // px headroom above slot 0 so its glow isn't clipped at the top — must match the extra height baked into #spotify-lyrics-window in CSS
        const LYRICS_SLOTS_AHEAD = 2;  // how many upcoming lines are visible below the current one
        let lyricsSlotEls = new Map();  // absolute lyric index -> DOM element currently representing it
        let lyricsWindowStart = null;   // the lyric index currently occupying slot role 0 (top/current)

        function getLyricsWindowEl() {
            return document.getElementById('spotify-lyrics-window');
        }

        function lyricsSlotTransform(role) {
            return `translate(-50%, ${role * LYRICS_ROW_HEIGHT + LYRICS_TOP_PAD}px)`;
        }

        function lyricsSlotOpacity(role) {
            if (role <= 0) return 1;
            if (role === 1) return 0.55;
            return 0.3;
        }

        let lyricsFadeOutTimeout = null;

        function resetLyricsConveyor() {
            if (lyricsFadeOutTimeout) {
                clearTimeout(lyricsFadeOutTimeout);
                lyricsFadeOutTimeout = null;
            }
            const windowEl = getLyricsWindowEl();
            if (windowEl) windowEl.innerHTML = '';
            lyricsSlotEls.clear();
            lyricsWindowStart = null;
        }

        // Shown while a new track's lyrics are being fetched, instead of just leaving
        // the panel blank — three shimmering placeholder bars in the same layout the
        // real lines will use once they arrive.
        function showLyricsLoading() {
            resetLyricsConveyor();
            const windowEl = getLyricsWindowEl();
            if (!windowEl) return;
            const widths = [72, 56, 40]; // % width per slot, loosely mimicking varied line lengths
            widths.forEach((widthPct, role) => {
                const bar = document.createElement('div');
                // Role 0 stands in for the current line and glows in the accent colour.
                bar.className = role === 0 ? 'lyrics-skeleton-line is-current' : 'lyrics-skeleton-line';
                bar.style.width = widthPct + '%';
                bar.style.transform = lyricsSlotTransform(role);
                bar.style.animationDelay = (role * 0.15) + 's';
                // Fade the bars in (from 0) to their resting per-slot opacity so the
                // loading state appears gently rather than popping — reads much better
                // on track changes and when alt-tabbing back to the overlay.
                bar.style.opacity = '0';
                windowEl.appendChild(bar);
                requestAnimationFrame(() => { bar.style.opacity = String(lyricsSlotOpacity(role)); });
            });
        }

        // Fades the currently-visible lines out (rather than yanking them away instantly),
        // then shows the loading skeleton once the fade finishes. Used when a track
        // changes, so the old song's lines visibly settle before the "fetching new
        // lyrics" state appears. If a new render happens before the fade finishes,
        // resetLyricsConveyor() above cancels this pending timeout so it can't wipe out
        // the new track's lines.
        function fadeOutLyricsConveyor() {
            for (const el of lyricsSlotEls.values()) {
                el.style.opacity = '0';
                el.classList.remove('lyrics-slot-current');
            }
            if (lyricsFadeOutTimeout) clearTimeout(lyricsFadeOutTimeout);
            lyricsFadeOutTimeout = setTimeout(showLyricsLoading, 400);
        }

        // Detects whether a lyric line ends with one or more trailing parenthesized
        // groups and, if so, returns the main text and the grouped paren text separately
        // so they can be rendered on two visual lines. Returns null if the line should
        // be rendered as a single unmodified string.
        //
        // Rules (per spec):
        //   ✓  "Scrape the bowl (skrrt, skrrt)"  →  split
        //   ✓  "Coupe (yeah) (what)"              →  split (multiple trailing groups)
        //   ✗  "I (can't) believe this"           →  no split (parens not purely at end)
        //   ✗  "(Instrumental)"                   →  no split (whole line is parens)
        //   ✗  "Hello world()"                    →  no split (empty parens)
        //   ✗  "Tell me why (yeah) tonight"       →  no split (parens mid-line)
        function parseLyricTrailingParens(text) {
            if (!text) return null;
            const trimmed = text.trimEnd();

            // Pattern breakdown:
            //   ^(.*?\S)   — main part ending at a non-whitespace char (lazy)
            //   \s+        — whitespace separating main text from trailing paren groups
            //   (          — all trailing paren groups:
            //     \(          open paren
            //     (?:[^()]+)  non-empty content (rejects "()")
            //     \)          close paren
            //     (?:\s*\((?:[^()]+)\))*  optional further groups e.g. "(yeah) (what)"
            //   )
            //   \s*$       — optional trailing whitespace
            const match = trimmed.match(
                /^(.*?\S)\s+(\((?:[^()]+)\)(?:\s*\((?:[^()]+)\))*)\s*$/
            );
            if (!match) return null;

            const mainPart  = match[1];
            const parenPart = match[2];

            // Require the main part to contain at least some non-paren text.
            // This allows mid-line parens like "blah (bleh) blah blah (blah)" to split
            // (mainPart="blah (bleh) blah blah", which has real text outside the parens),
            // while still rejecting lines that are entirely composed of paren groups
            // like "(yeah) (what)" where the mainPart would be "(yeah)" with no real text.
            const mainStrippedOfParens = mainPart.replace(/\((?:[^()]+)\)/g, '').trim();
            if (!mainStrippedOfParens) return null;

            return { main: mainPart, secondary: parenPart };
        }

        function createLyricsSlotEl(index, canSeek) {
            const line = spotifyCurrentLyricsDisplay[index];
            const el = document.createElement('div');
            el.className = 'lyrics-slot';
            el.dataset.idx = String(index);
            el.title = line.text; // always the full original text for the tooltip
            el.style.cursor = canSeek ? 'pointer' : 'default';

            const parsed = parseLyricTrailingParens(line.text);
            if (parsed) {
                // Two-line layout: main lyric on top, paren group(s) below at 75% size.
                // Both are plain textContent (no innerHTML), so no injection risk.
                // text-shadow/glow is inherited by the child spans, so the paren line
                // glows in sync with the main text when this slot is the current line.
                const mainSpan = document.createElement('span');
                mainSpan.className = 'lyrics-main-text';
                mainSpan.textContent = parsed.main;
                el.appendChild(mainSpan);

                const parenSpan = document.createElement('span');
                parenSpan.className = 'lyrics-paren-text';
                parenSpan.textContent = parsed.secondary;
                el.appendChild(parenSpan);
            } else {
                el.textContent = line.text;
            }

            return el;
        }

        // Positions each currently-visible lyric slot by stacking measured heights:
        // slot 0 sits at LYRICS_TOP_PAD, and every line below starts LYRICS_GAP px under
        // the *actual rendered bottom* of the line above it. This is what prevents the
        // occasional overlap — a line that wraps to two/three visual rows simply pushes
        // the next line further down instead of colliding with it. Returns idx -> top-Y
        // so callers can position a freshly-added bottom line relative to its final spot.
        function layoutLyricsSlots(start) {
            const positions = new Map();
            let y = LYRICS_TOP_PAD;
            for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
                const idx = start + role;
                const el = lyricsSlotEls.get(idx);
                if (!el) continue;
                el.style.transform = `translate(-50%, ${y}px)`;
                positions.set(idx, y);
                y += (el.offsetHeight || LYRICS_ROW_HEIGHT) + LYRICS_GAP;
            }
            return positions;
        }

        // Renders the slot window (current + upcoming lines) around currentLyricsLineIndex.
        // A natural single-line forward advance animates (slide up + fade, pull up, fade in).
        // Anything else — first load, track change, a manual seek that jumps several lines —
        // snaps the whole window in fresh instead of flying across several slots at once.
        // In both cases the vertical positions come from layoutLyricsSlots (measured), not
        // a fixed per-row stride, so wrapped lines never overlap.
        function renderLyricsWindow(forceSnap = false) {
            const windowEl = getLyricsWindowEl();
            if (!windowEl) return;

            if (!spotifyCurrentLyricsDisplay.length) {
                resetLyricsConveyor();
                return;
            }

            const total = spotifyCurrentLyricsDisplay.length;
            const activeIdx = currentLyricsLineIndex; // -1 means playback hasn't reached line 0 yet
            const newStart = Math.max(0, Math.min(activeIdx < 0 ? 0 : activeIdx, total - 1));
            const canSeek = !!spotifyCurrentLyrics?.synced;
            const forwardStep = lyricsWindowStart === null ? null : newStart - lyricsWindowStart;
            const snap = forceSnap || forwardStep === null || forwardStep !== 1;

            if (snap) {
                resetLyricsConveyor();
                const freshEls = [];
                for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
                    const idx = newStart + role;
                    if (idx < 0 || idx >= total) continue;
                    const el = createLyricsSlotEl(idx, canSeek);
                    el.style.transition = 'none';
                    el.style.opacity = String(lyricsSlotOpacity(role));
                    el.classList.toggle('lyrics-slot-current', idx === activeIdx);
                    windowEl.appendChild(el);
                    lyricsSlotEls.set(idx, el);
                    freshEls.push(el);
                }
                // Position by measured height (elements are in the DOM now, so offsetHeight
                // is real), then re-enable transitions next frame so future moves animate.
                layoutLyricsSlots(newStart);
                lyricsWindowStart = newStart;
                requestAnimationFrame(() => { for (const el of freshEls) el.style.transition = ''; });
                return;
            }

            // Natural forward step by exactly one line — animate the conveyor.
            const outgoingIdx = lyricsWindowStart;
            const outgoingEl = lyricsSlotEls.get(outgoingIdx);

            // Add the new bottom line first (hidden) so it's measurable during layout.
            let incomingEl = null;
            const bottomIdx = newStart + LYRICS_SLOTS_AHEAD;
            if (bottomIdx < total && !lyricsSlotEls.has(bottomIdx)) {
                incomingEl = createLyricsSlotEl(bottomIdx, canSeek);
                incomingEl.style.transition = 'none';
                incomingEl.style.opacity = '0';
                windowEl.appendChild(incomingEl);
                lyricsSlotEls.set(bottomIdx, incomingEl);
            }

            // Update highlight + resting opacity for the lines that stay on screen.
            for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
                const idx = newStart + role;
                const el = lyricsSlotEls.get(idx);
                if (!el || el === incomingEl) continue;
                el.style.opacity = String(lyricsSlotOpacity(role));
                el.classList.toggle('lyrics-slot-current', idx === activeIdx);
            }

            // Slide the scrolled-past line up out of view (by its own measured height), then remove.
            if (outgoingEl) {
                const h = outgoingEl.offsetHeight || LYRICS_ROW_HEIGHT;
                outgoingEl.style.transform = `translate(-50%, ${LYRICS_TOP_PAD - h - LYRICS_GAP}px)`;
                outgoingEl.style.opacity = '0';
                outgoingEl.classList.remove('lyrics-slot-current');
                lyricsSlotEls.delete(outgoingIdx);
                setTimeout(() => outgoingEl.remove(), 500);
            }

            // Position every visible line by measured height; the ones already on screen
            // have transitions enabled, so they smoothly slide into their new slots.
            const positions = layoutLyricsSlots(newStart);

            // Fade + pull the freshly added bottom line into place from just below.
            if (incomingEl) {
                const finalY = positions.get(bottomIdx) ?? LYRICS_TOP_PAD;
                incomingEl.style.transform = `translate(-50%, ${finalY + 14}px)`;
                requestAnimationFrame(() => {
                    incomingEl.style.transition = '';
                    incomingEl.style.transform = `translate(-50%, ${finalY}px)`;
                    incomingEl.style.opacity = String(lyricsSlotOpacity(LYRICS_SLOTS_AHEAD));
                });
            }

            lyricsWindowStart = newStart;
        }

        // ── Next-song prefetch ──
        // While a song plays, we look ahead at the Spotify queue and fetch the NEXT
        // track's lyrics in the background, cached here by track id. When the song
        // actually changes we already have them, so the panel swaps straight to the new
        // lyrics instead of showing the "fetching…" skeleton for a second or two.
        const lyricsCacheById = new Map();   // trackId -> getLyrics result
        const LYRICS_CACHE_MAX = 16;
        let lyricsPrefetchInFlight = new Set();

        function cacheLyricsResult(id, result) {
            if (!id || !result) return;
            if (lyricsCacheById.has(id)) lyricsCacheById.delete(id);
            lyricsCacheById.set(id, result);
            while (lyricsCacheById.size > LYRICS_CACHE_MAX) {
                lyricsCacheById.delete(lyricsCacheById.keys().next().value);
            }
        }

        // Applies an already-resolved lyrics result to the panel (shared by the normal
        // fetch path and the instant cache-hit path).
        function applyLyricsResult(track, result, snap) {
            if (!result || !result.success) {
                if (result && !result.success) showLyricsUnavailable();
                else clearLyricsDisplay();
                return;
            }
            spotifyCurrentLyrics = result;
            spotifyCurrentLyricsDisplay = result.lyrics || [];
            lyricsLastKnownProgressMs = track.progress_ms || 0;
            lyricsLastKnownProgressAt = performance.now();

            const lines = spotifyCurrentLyricsDisplay;
            let startLineIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                const effectiveTime = lyricsEffectiveTime(lines[i].time);
                if (effectiveTime != null && effectiveTime <= lyricsLastKnownProgressMs) {
                    startLineIndex = i;
                } else {
                    break;
                }
            }
            currentLyricsLineIndex = startLineIndex;
            renderLyricsWindow(true); // fresh track — snap the window in, no fly-in animation
        }

        // Look at the queue and warm the cache for the upcoming track(s). Cheap and
        // fire-and-forget — failures are ignored, the normal on-change fetch still works.
        async function prefetchQueuedLyrics() {
            if (!window.electronAPI?.spotifyGetQueue || !window.electronAPI?.getLyrics) return;
            try {
                const q = await window.electronAPI.spotifyGetQueue();
                const upcoming = (q?.queue || []).slice(0, 2); // the next couple of tracks
                for (const next of upcoming) {
                    if (!next?.id || !next.name || !next.artist) continue;
                    if (lyricsCacheById.has(next.id) || lyricsPrefetchInFlight.has(next.id)) continue;
                    lyricsPrefetchInFlight.add(next.id);
                    window.electronAPI.getLyrics(next.name, next.artist, next.album, next.duration_ms)
                        .then((res) => { if (res) cacheLyricsResult(next.id, res); })
                        .catch(() => {})
                        .finally(() => lyricsPrefetchInFlight.delete(next.id));
                }
            } catch (e) { /* queue unavailable — ignore */ }
        }

        async function loadLyricsForTrack(track) {
            if (!track?.name || !track?.artist) {
                clearLyricsDisplay();
                return;
            }

            const requestId = ++lyricsRequestSeq;
            lyricsTrackId = track.id || null;

            // Drop the previous track's lyrics state right away. Without this, the 250ms
            // interpolation loop keeps advancing/highlighting the OLD song's lyrics off
            // its stale clock for as long as this fetch takes — which is what caused
            // lyrics to visibly glitch/lag right at the moment a song changes.
            spotifyCurrentLyrics = null;
            spotifyCurrentLyricsDisplay = [];
            currentLyricsLineIndex = -1;

            // Prefetched? Swap straight in — no fade-to-skeleton, no network wait.
            if (track.id && lyricsCacheById.has(track.id)) {
                applyLyricsResult(track, lyricsCacheById.get(track.id), true);
                prefetchQueuedLyrics(); // warm the NEW next track
                return;
            }

            // Not cached — fade the old lines out and fetch (skeleton appears only if
            // the fetch takes longer than the fade).
            fadeOutLyricsConveyor();

            try {
                const result = await window.electronAPI?.getLyrics?.(
                    track.name, track.artist, track.album, track.duration_ms
                );

                // A newer track change started (and possibly finished) while this
                // request was in flight — discard this result, it's stale.
                if (requestId !== lyricsRequestSeq) return;

                if (result && track.id) cacheLyricsResult(track.id, result);

                if (!result) {
                    clearLyricsDisplay();
                    return;
                }
                applyLyricsResult(track, result, true);
                prefetchQueuedLyrics(); // now warm the next track for a seamless change
            } catch (e) {
                if (requestId !== lyricsRequestSeq) return;
                console.error('[Lyrics] Failed to load lyrics', e);
                showLyricsUnavailable();
            }
        }

        function clearLyricsDisplay() {
            spotifyCurrentLyrics = null;
            spotifyCurrentLyricsDisplay = [];
            currentLyricsLineIndex = -1;
            lyricsTrackId = null;
            resetLyricsConveyor();
        }

        function showLyricsUnavailable() {
            resetLyricsConveyor();
            const windowEl = getLyricsWindowEl();
            if (windowEl) {
                windowEl.innerHTML =
                    '<div class="lyrics-unavailable-wrap">' +
                        '<div class="lyrics-unavailable-badge"><i class="fas fa-microphone-slash"></i></div>' +
                        '<span class="lyrics-unavailable-title">No lyrics found</span>' +
                        '<span class="lyrics-unavailable-sub">Nothing synced for this track yet</span>' +
                    '</div>';
            }
        }

        // Finds the line that should be current for a given playback position, using
        // each line's real lrclib timestamp (shifted slightly earlier, see
        // LYRICS_ANTICIPATE_MS above). If the current track only has plain (untimed)
        // lyrics, this intentionally does nothing — guessing a highlight without real
        // timing data is worse than just showing the lyrics unhighlighted.
        function syncLyricsWithPlayback(progressMs) {
            if (!spotifyCurrentLyrics?.synced || !spotifyCurrentLyricsDisplay.length) return;

            const lines = spotifyCurrentLyricsDisplay;
            let newLineIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lyricsEffectiveTime(lines[i].time) <= progressMs) {
                    newLineIndex = i;
                } else {
                    break;
                }
            }

            if (newLineIndex !== currentLyricsLineIndex) {
                currentLyricsLineIndex = newLineIndex;
                renderLyricsWindow();
            }
        }

        // Runs independently of the 1s Spotify poll so the highlighted line advances
        // smoothly in between polls, and the slide/fade animation plays at roughly the
        // real moment instead of jumping once a second.
        setInterval(() => {
            if (!spotifyIsPlaying || !spotifyCurrentLyrics?.synced) return;
            const elapsed = performance.now() - lyricsLastKnownProgressAt;
            const estimatedProgressMs = lyricsLastKnownProgressMs + elapsed;
            syncLyricsWithPlayback(estimatedProgressMs);
        }, 250);

        // When the user switches away and comes back, performance.now() has kept
        // ticking even though the tab was paused — so `elapsed` would be huge and
        // the next interpolation tick would jump far ahead in the lyrics, moving the
        // conveyor to the wrong line. Resetting the reference point on tab-show
        // makes elapsed = 0 at that moment; the next Spotify poll then sets the
        // correct real position.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                lyricsLastKnownProgressAt = performance.now();
                lyricsResyncOnReturn();
            }
        });

        // This app is a translucent always-on-top overlay, so alt-tabbing to another
        // window usually leaves it *visible* (only unfocused) — visibilitychange never
        // fires, but background timers are throttled, so on the way back the lyrics can
        // be a few seconds stale and the highlighted line looks wrong until the next
        // 2.5s poll. Re-poll immediately on focus (throttled) so lyrics snap to the
        // right line the instant you alt-tab back, and fill in if nothing's loaded yet.
        let lyricsLastReturnResync = 0;
        function lyricsResyncOnReturn() {
            const now = Date.now();
            if (now - lyricsLastReturnResync < 800) return; // don't spam on rapid focus flips
            lyricsLastReturnResync = now;
            lyricsLastKnownProgressAt = performance.now();
            if (!spotifyCurrentTrack) return;
            // A fresh poll gets the true position and (re)loads lyrics if the track
            // changed while we were away; loads are instant when prefetched.
            if (typeof updateSpotifyWidget === 'function') {
                Promise.resolve(updateSpotifyWidget()).catch(() => {});
            } else {
                syncLyricsWithPlayback(lyricsLastKnownProgressMs);
            }
        }
        window.addEventListener('focus', lyricsResyncOnReturn);

        function seekToLyricsLine(lineIndex) {
            const line = spotifyCurrentLyricsDisplay[lineIndex];
            const target = line ? lyricsEffectiveTime(line.time) : null;
            if (target == null) return; // no real timestamp to seek to
            spotifySeek(Math.max(0, Math.min(target, spotifyCurrentTrack?.duration_ms || target)));
        }

        // Click-to-seek is delegated from the window container, since the slot elements
        // get recreated/recycled as the conveyor advances rather than living forever.
        (function setupLyricsClickDelegation() {
            const windowEl = getLyricsWindowEl();
            if (!windowEl) return;
            windowEl.addEventListener('click', (event) => {
                const slot = event.target.closest('.lyrics-slot');
                if (!slot || !spotifyCurrentLyrics?.synced) return;
                const idx = parseInt(slot.dataset.idx, 10);
                if (!Number.isNaN(idx)) seekToLyricsLine(idx);
            });
        })();

        // The lyrics panel keeps the SAME look and behavior either way — only the size
        // changes. When other widgets (Quick Notes, Performance) are also shown, this
        // card gets narrower (#widgets-row drops to fewer grid columns), so the lyric
        // text shrinks to keep fitting cleanly instead of wrapping into a cramped mess.
        // When the panel has the full card to itself, text stays at its normal size.
        function computeLyricsFontSize(panelWidthPx) {
            const minW = 75, maxW = 180;     // panel width range we scale across
            const minFont = 9, maxFont = 13; // font-size range (13px is the normal/default size)
            if (panelWidthPx <= minW) return minFont;
            if (panelWidthPx >= maxW) return maxFont;
            const t = (panelWidthPx - minW) / (maxW - minW);
            return Math.round((minFont + t * (maxFont - minFont)) * 10) / 10;
        }

        (function setupLyricsResponsiveSizing() {
            const panel = document.getElementById('spotify-lyrics-panel');
            if (!panel || typeof ResizeObserver === 'undefined') return;

            let lastAppliedWidth = null;
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const width = Math.round(entry.contentRect.width);
                    if (width === lastAppliedWidth) continue;
                    lastAppliedWidth = width;
                    const fontSize = computeLyricsFontSize(width);
                    panel.style.setProperty('--lyrics-font-size', fontSize + 'px');
                    // Inset the text well in from each side. The current line's glow
                    // (text-shadow blur ~20px) renders OUTSIDE the text box, and the
                    // window/panel both clip with overflow:hidden — so if the text runs
                    // near the edge the glow gets sheared off. Keeping ~22px of margin on
                    // each side lets the horizontal glow sit inside the clip box. The
                    // inset shrinks a bit at very narrow widths so the text still fits.
                    const sideInset = Math.min(22, Math.max(8, Math.round(width * 0.12)));
                    panel.style.setProperty('--lyrics-max-width', Math.max(56, width - sideInset * 2) + 'px');
                }
            });
            observer.observe(panel);
        })();

        function openLyricsModal() {
            const modal = document.getElementById('lyrics-modal');
            if (!modal) return;
            cancelModalClose(modal);
            modal.classList.add('shown');

            const fullList = document.getElementById('lyrics-full-list');
            if (!fullList || !spotifyCurrentLyricsDisplay.length) return;

            const canSeek = !!spotifyCurrentLyrics?.synced;
            let html = '';
            for (let i = 0; i < spotifyCurrentLyricsDisplay.length; i++) {
                const line = spotifyCurrentLyricsDisplay[i];
                const isCurrent = i === currentLyricsLineIndex;
                const clickAttr = canSeek ? ` onclick="seekToLyricsLine(${i})"` : '';
                const parsed = parseLyricTrailingParens(line.text);
                if (parsed) {
                    html += `<div class="lyrics-full-line${isCurrent ? ' current' : ''}"${clickAttr}>`
                          + `<span class="lyrics-main-text">${escapeHtml(parsed.main)}</span>`
                          + `<span class="lyrics-paren-text">${escapeHtml(parsed.secondary)}</span>`
                          + `</div>`;
                } else {
                    html += `<div class="lyrics-full-line${isCurrent ? ' current' : ''}"${clickAttr}>${escapeHtml(line.text)}</div>`;
                }
            }
            fullList.innerHTML = html;

            // Update header with track info
            const header = document.getElementById('lyrics-modal-track-info');
            if (header && spotifyCurrentLyrics?.track) {
                const track = spotifyCurrentLyrics.track;
                header.textContent = `${track.artist} • ${track.album}`;
            }
        }

        function closeLyricsModal() {
            const modal = document.getElementById('lyrics-modal');
            if (modal) animateModalClose(modal, () => modal.classList.remove('shown'));
        }

        // Hook into updateSpotifyWidget to load lyrics when track changes
        const originalUpdateSpotifyWidget = updateSpotifyWidget;
        updateSpotifyWidget = async function() {
            await originalUpdateSpotifyWidget();

            if (spotifyCurrentTrack && spotifyCurrentTrack.id !== lyricsTrackId) {
                loadLyricsForTrack(spotifyCurrentTrack);
            } else if (spotifyCurrentTrack && spotifyIsPlaying) {
                // Same track — just resync our local clock to the freshly polled position.
                lyricsLastKnownProgressMs = spotifyCurrentTrack.progress_ms || 0;
                lyricsLastKnownProgressAt = performance.now();
                syncLyricsWithPlayback(lyricsLastKnownProgressMs);
            }
        };
