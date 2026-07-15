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
        const LYRICS_ROW_HEIGHT = 56;  // px slot-to-slot distance — must match .lyrics-slot max-height and (#spotify-lyrics-window height = 3×this + LYRICS_TOP_PAD)
        const LYRICS_TOP_PAD = 20;     // px headroom above slot 0 so its glow isn't clipped — must match the extra height baked into #spotify-lyrics-window in CSS
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
            const widths = [62, 48, 36]; // % width per slot, loosely mimicking varied line lengths
            widths.forEach((widthPct, role) => {
                const bar = document.createElement('div');
                bar.className = 'lyrics-skeleton-line';
                bar.style.width = widthPct + '%';
                bar.style.transform = lyricsSlotTransform(role);
                bar.style.opacity = String(lyricsSlotOpacity(role));
                bar.style.animationDelay = (role * 0.15) + 's';
                windowEl.appendChild(bar);
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

        // Renders the slot window (current + upcoming lines) around currentLyricsLineIndex.
        // A natural single-line forward advance animates (slide up + fade, pull up, fade in).
        // Anything else — first load, track change, a manual seek that jumps several lines —
        // snaps the whole window in fresh instead of flying across several slots at once.
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
                for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
                    const idx = newStart + role;
                    if (idx < 0 || idx >= total) continue;
                    const el = createLyricsSlotEl(idx, canSeek);
                    el.style.transition = 'none';
                    el.style.transform = lyricsSlotTransform(role);
                    el.style.opacity = String(lyricsSlotOpacity(role));
                    el.classList.toggle('lyrics-slot-current', idx === activeIdx);
                    windowEl.appendChild(el);
                    lyricsSlotEls.set(idx, el);
                    // Re-enable the transition next frame so future moves animate smoothly.
                    requestAnimationFrame(() => { el.style.transition = ''; });
                }
                lyricsWindowStart = newStart;
                return;
            }

            // Natural forward step by exactly one line — animate the conveyor.
            const outgoingIdx = lyricsWindowStart;
            const outgoingEl = lyricsSlotEls.get(outgoingIdx);
            if (outgoingEl) {
                outgoingEl.style.transform = lyricsSlotTransform(-1);
                outgoingEl.style.opacity = '0';
                outgoingEl.classList.remove('lyrics-slot-current');
                lyricsSlotEls.delete(outgoingIdx);
                setTimeout(() => outgoingEl.remove(), 500);
            }

            for (let idx = newStart; idx < newStart + LYRICS_SLOTS_AHEAD; idx++) {
                const el = lyricsSlotEls.get(idx);
                if (!el) continue;
                const role = idx - newStart;
                el.style.transform = lyricsSlotTransform(role);
                el.style.opacity = String(lyricsSlotOpacity(role));
                el.classList.toggle('lyrics-slot-current', idx === activeIdx);
            }

            const newIdx = newStart + LYRICS_SLOTS_AHEAD;
            if (newIdx < total && !lyricsSlotEls.has(newIdx)) {
                const el = createLyricsSlotEl(newIdx, canSeek);
                el.style.transition = 'none';
                el.style.transform = lyricsSlotTransform(LYRICS_SLOTS_AHEAD + 1);
                el.style.opacity = '0';
                windowEl.appendChild(el);
                lyricsSlotEls.set(newIdx, el);
                requestAnimationFrame(() => {
                    el.style.transition = '';
                    el.style.transform = lyricsSlotTransform(LYRICS_SLOTS_AHEAD);
                    el.style.opacity = String(lyricsSlotOpacity(LYRICS_SLOTS_AHEAD));
                });
            }

            lyricsWindowStart = newStart;
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
            // lyrics to visibly glitch/lag right at the moment a song changes. The old
            // lines fade out gracefully instead of just freezing or vanishing.
            spotifyCurrentLyrics = null;
            spotifyCurrentLyricsDisplay = [];
            currentLyricsLineIndex = -1;
            fadeOutLyricsConveyor();

            try {
                const result = await window.electronAPI?.getLyrics?.(
                    track.name, track.artist, track.album, track.duration_ms
                );

                // A newer track change started (and possibly finished) while this
                // request was in flight — discard this result, it's stale.
                if (requestId !== lyricsRequestSeq) return;

                if (!result) {
                    clearLyricsDisplay();
                    return;
                }

                if (!result.success) {
                    showLyricsUnavailable();
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
                        '<i class="fas fa-music lyrics-unavailable-icon"></i>' +
                        '<span class="lyrics-unavailable-title">No Lyrics</span>' +
                        '<span class="lyrics-unavailable-sub">unavailable for this track</span>' +
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
        // makes elapsed = 0 at that moment; the next Spotify poll (within ~1s) then
        // sets the correct real position.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                lyricsLastKnownProgressAt = performance.now();
            }
        });

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
                    // Leave a little breathing room on each side so wrapped text never
                    // touches the panel's own edges, even at the narrowest widths.
                    panel.style.setProperty('--lyrics-max-width', Math.max(60, width - 10) + 'px');
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
