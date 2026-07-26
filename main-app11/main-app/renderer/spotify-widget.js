        // ── Title/artist "marquee" reveal ──
        // If text fits in its container, it just sits there, centered/static, as normal.
        // If it's too long: title and artist both loop on the SAME shared schedule —
        // 3s after a new track is first shown, then every 6s after that — so they always
        // start at the exact same moment, even if only one of them happens to overflow.
        // Motion is a continuous one-directional loop (never an animated "slide back"):
        // the text scrolls left, wraps around like a belt, and arrives back at its
        // default resting spot still moving left the whole time. This works by quietly
        // rendering a second copy of the text right after the first — once the first
        // copy has scrolled fully out of view, the second copy is sitting exactly where
        // the first one started, so resetting the position at that exact instant is
        // completely invisible. If one of the two is shorter and finishes its loop
        // first, it simply rests at the default spot until the other one also finishes —
        // they don't start a new loop independently of each other.
        const MARQUEE_INITIAL_DELAY_MS = 3000;
        const MARQUEE_INTERVAL_MS = 6000;
        const MARQUEE_PX_PER_MS = 0.04; // ~40px/sec — a comfortable, readable scroll speed

        const marqueeRegistry = new Map(); // containerEl -> { track, copy1, repeatDistance, overflowing }
        let marqueeScheduleTimer = null;

        // Sets text into a marquee-capable container, replacing whatever was there.
        // Does NOT start any animation itself — call restartMarqueeSchedule() once
        // after setting both the title and artist for a track so they stay in sync.
        function setMarqueeText(containerEl, text) {
            if (!containerEl) return;

            containerEl.innerHTML = '';
            containerEl.classList.remove('marquee-fade-right', 'marquee-fade-both');
            const track = document.createElement('span'); // the element that actually gets translateX'd
            track.className = 'marquee-text';
            track.style.transition = 'none';
            track.style.transform = 'translateX(0)';

            const copy1 = document.createElement('span');
            copy1.className = 'marquee-copy';
            copy1.textContent = text;
            track.appendChild(copy1);
            containerEl.appendChild(track);

            const record = { track, copy1, repeatDistance: 0, overflowing: false, container: containerEl };
            marqueeRegistry.set(containerEl, record);

            requestAnimationFrame(() => {
                if (marqueeRegistry.get(containerEl) !== record) return; // superseded already
                const overflowPx = copy1.scrollWidth - containerEl.clientWidth;
                if (overflowPx <= 2) return; // fits fine as a single static copy

                // Add a subtle right-edge fade so the cutoff isn't a hard line.
                containerEl.classList.add('marquee-fade-right');

                // Add a gap + a second copy so the loop has somewhere seamless to land.
                const gap = document.createElement('span');
                gap.className = 'marquee-gap';
                gap.textContent = '\u2002•\u2002';
                track.appendChild(gap);

                const copy2 = document.createElement('span');
                copy2.className = 'marquee-copy';
                copy2.textContent = text;
                track.appendChild(copy2);

                record.overflowing = true;
                record.repeatDistance = copy1.offsetWidth + gap.offsetWidth;
            });
        }

        // (Re)starts the shared loop schedule. Called once per track change, right
        // after both title and artist have had setMarqueeText() applied.
        function restartMarqueeSchedule() {
            if (marqueeScheduleTimer) clearTimeout(marqueeScheduleTimer);

            function runLoopCycle(record) {
                if (!record || !record.overflowing) return;
                const { track, repeatDistance, container } = record;
                // Clamp so an unusually long title can never run long enough to bump
                // into the next scheduled cycle.
                const maxTravelMs = Math.max(400, MARQUEE_INTERVAL_MS - 500);
                const travelMs = Math.min(maxTravelMs, Math.max(600, repeatDistance / MARQUEE_PX_PER_MS));

                // Switch to both-edge fade while the text is scrolling so it
                // appears / disappears smoothly as it enters and exits the viewport.
                container.classList.remove('marquee-fade-right');
                container.classList.add('marquee-fade-both');

                track.style.transition = `transform ${travelMs}ms linear`;
                track.style.transform = `translateX(-${repeatDistance}px)`;

                // The instant the loop completes, the (identical) second copy is sitting
                // exactly where the first one started — so snapping back here is invisible.
                // If the other element's text is longer, it just keeps going; this one
                // simply rests at the default spot until the next shared tick.
                setTimeout(() => {
                    track.style.transition = 'none';
                    track.style.transform = 'translateX(0)';
                    container.classList.remove('marquee-fade-both');
                    container.classList.add('marquee-fade-right');
                }, travelMs);
            }

            function tick() {
                for (const record of marqueeRegistry.values()) {
                    runLoopCycle(record);
                }
                marqueeScheduleTimer = setTimeout(tick, MARQUEE_INTERVAL_MS);
            }

            marqueeScheduleTimer = setTimeout(tick, MARQUEE_INITIAL_DELAY_MS);
        }


        function updateSpotifyUI(data) {
            const idle = document.getElementById('spotify-idle');
            const active = document.getElementById('spotify-active');
            const connectBtn = document.getElementById('spotify-connect-widget-btn');
            const trackEl = document.getElementById('spotify-track');
            const artistEl = document.getElementById('spotify-artist');
            const playBtn = document.getElementById('spotify-play-btn');

            if (data.connected === false) {
                idle.classList.remove('hidden');
                active.classList.add('hidden');
                if (connectBtn) connectBtn.classList.remove('hidden');
                const statusText = document.getElementById('spotify-status-text');
                if (statusText) {
                    if (spotifyRetryCount > 0 && spotifyRetryCount < 8) {
                        statusText.textContent = `Connecting... (${spotifyRetryCount})`;
                    } else if (spotifyRetryCount >= 8) {
                        statusText.innerHTML = `Connection failed<br><span class="text-[10px] text-neutral-600">No active Spotify device or API error</span>`;
                    } else {
                        statusText.textContent = 'Not connected';
                    }
                }
                spotifyIsPlaying = false;
                spotifyCurrentTrack = null;
                updateBeatEngineFromPlayback(null);
                updateVisualizerFromPlayback(null);
                if (typeof spotifyEnhancedOnTrackChanged === 'function') spotifyEnhancedOnTrackChanged(null);
                return;
            }

            idle.classList.add('hidden');
            active.classList.remove('hidden');
            if (connectBtn) connectBtn.classList.add('hidden');

            // Volume (Update even if no track is active)
            if (typeof data.volume_percent === 'number') {
                const volSlider = document.getElementById('spotify-volume');
                const suppress = isDraggingVolume || (Date.now() - lastVolumeChangeTime < 400);
                if (volSlider && !suppress) {
                    volSlider.value = data.volume_percent;
                    const volNum = Number(data.volume_percent);
                    const pct = Math.max(0, Math.min(100, volNum));
                    volSlider.style.background = `linear-gradient(to right, var(--accent-solid, #fff) ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
                    spotifyUpdateVolumeIcon(data.volume_percent);
                }
            }

            if (!data.track) {
                spotifyTargetVelocity = 0;
                if (marqueeScheduleTimer) clearTimeout(marqueeScheduleTimer);
                setMarqueeText(trackEl, 'No track playing');
                setMarqueeText(artistEl, 'Spotify idle');
                playBtn.classList.remove('is-playing');
                spotifyIsPlaying = false;
                spotifyCurrentTrack = null;
                updateBeatEngineFromPlayback(data);
                updateVisualizerFromPlayback(data);
                if (typeof spotifyEnhancedOnTrackChanged === 'function') spotifyEnhancedOnTrackChanged(null);
                return;
            }

            const trackChanged = !spotifyCurrentTrack || spotifyCurrentTrack.id !== data.track.id;
            if (trackChanged) {
                trackEl.style.opacity = '0';
                artistEl.style.opacity = '0';
                setTimeout(() => {
                    setMarqueeText(trackEl, data.track.name);
                    setMarqueeText(artistEl, data.track.artist);
                    trackEl.style.opacity = '1';
                    artistEl.style.opacity = '1';
                    restartMarqueeSchedule(); // 3s-then-6s cycle starts counting from right now
                }, 150);

                const albumCoverEl = document.getElementById('spotify-album-cover');
                if (albumCoverEl) {
                    albumCoverEl.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
                    albumCoverEl.style.opacity = '0';
                    albumCoverEl.style.transform = 'scale(0.9)';
                    setTimeout(() => {
                        if (data.track.image) {
                            albumCoverEl.onerror = () => { albumCoverEl.style.display = 'none'; };
                            albumCoverEl.src = data.track.image;
                            albumCoverEl.style.display = 'block';
                        } else {
                            albumCoverEl.src = '';
                            albumCoverEl.style.display = 'none';
                        }
                        // Apple Music-style "now playing" entrance: pop in with a soft
                        // overshoot rather than just fading flatly.
                        albumCoverEl.style.transition = 'opacity 0.35s ease, transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
                        albumCoverEl.style.opacity = '1';
                        albumCoverEl.style.transform = 'scale(1)';
                    }, 150);
                }
            }

            spotifyIsPlaying = data.is_playing;
            spotifyTargetVelocity = data.is_playing ? getDiskMaxSpeed() : 0;
            spotifyCurrentTrack = data.track;

            if (trackChanged && typeof spotifyEnhancedOnTrackChanged === 'function') {
                spotifyEnhancedOnTrackChanged(data.track);
            }

            playBtn.classList.toggle('is-playing', data.is_playing);

            // Vinyl glow (static fallback when beat-reactive glow is off or beat data unavailable)
            const disk = document.getElementById('spotify-disk');
            if (disk) {
                const beatGlowOn = isBeatGlowEnabled();
                const waitingForData = beatGlowOn && beatEngineState.loadingTrackId === data.track.id;
                const noBeatData = beatGlowOn && beatEngineState.mode === 'none' && !waitingForData;
                const useStaticGlow = !beatGlowOn || noBeatData;
                disk.classList.toggle('vinyl-glow-active', data.is_playing && useStaticGlow);
                if (useStaticGlow) disk.style.filter = '';
            }

            updateBeatEngineFromPlayback(data);
            updateVisualizerFromPlayback(data);

            const progressBar = document.getElementById('spotify-progress-bar');
            const timeCurrent = document.getElementById('spotify-time-current');
            const timeTotal = document.getElementById('spotify-time-total');
            if (progressBar && data.track.duration_ms > 0 && !isDraggingProgress) {
                const progress = Math.max(0, Math.min(data.track.duration_ms, data.track.progress_ms || 0));
                const pct = Math.max(0, Math.min(100, (progress / data.track.duration_ms) * 100));
                progressBar.style.width = pct + '%';
            }
            if (timeCurrent) timeCurrent.textContent = formatMsTime(data.track.progress_ms || 0);
            if (timeTotal) {
                const timerMode = localStorage.getItem('spotifyTimerMode') || 'total';
                if (timerMode === 'remaining') {
                    const remaining = Math.max(0, data.track.duration_ms - (data.track.progress_ms || 0));
                    timeTotal.textContent = formatMsTime(remaining);
                } else {
                    timeTotal.textContent = formatMsTime(data.track.duration_ms);
                }
            }
        }

        function formatMsTime(ms) {
            if (!ms || ms < 0) return '0:00';
            const totalSeconds = Math.floor(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }

        async function spotifySetVolume(value) {
            if (!window.electronAPI?.spotifySetVolume) return;
            try {
                await window.electronAPI.spotifySetVolume(parseInt(value, 10));
            } catch (e) {
                showToast('Volume change failed', true);
            }
        }

        let volumeSliderTimeout = null;

        function spotifyVolumeSliderInput(value) {
            lastVolumeChangeTime = Date.now();
            spotifyUpdateVolumeIcon(value);
            const slider = document.getElementById('spotify-volume');
            if (slider) {
                const volNum = Number(value);
                const pct = Math.max(0, Math.min(100, volNum));
                slider.style.background = `linear-gradient(to right, var(--accent-solid, #fff) ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            }
            clearTimeout(volumeSliderTimeout);
            volumeSliderTimeout = setTimeout(() => spotifySetVolume(value), 50);
        }

        function spotifyUpdateVolumeIcon(value) {
            const icon = document.getElementById('spotify-vol-icon');
            if (!icon) return;
            const volNum = Number(value);
            icon.className = 'fas text-[9px] text-neutral-500 w-3 text-center';
            if (volNum === 0) icon.classList.add('fa-volume-xmark');
            else if (volNum < 30) icon.classList.add('fa-volume-off');
            else if (volNum < 60) icon.classList.add('fa-volume-low');
            else icon.classList.add('fa-volume-high');
        }

        async function spotifyAdjustVolumeBy(delta) {
            if (!window.electronAPI?.spotifySetVolume) return;
            try {
                const volSlider = document.getElementById('spotify-volume');
                const currentVol = volSlider ? parseInt(volSlider.value, 10) : 50;
                const newVol = Math.max(0, Math.min(100, currentVol + delta));
                lastVolumeChangeTime = Date.now();
                if (volSlider) {
                    volSlider.value = newVol;
                    const pct = Math.max(0, Math.min(100, newVol));
                    volSlider.style.background = `linear-gradient(to right, var(--accent-solid, #fff) ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
                }
                spotifyUpdateVolumeIcon(newVol);
                await window.electronAPI.spotifySetVolume(newVol);
            } catch (e) {
                showToast('Volume change failed', true);
            }
        }

        async function spotifySeek(positionMs) {
            if (!window.electronAPI?.spotifySeek) return;
            try {
                await window.electronAPI.spotifySeek(positionMs);
                setTimeout(updateSpotifyWidget, 200);
            } catch (e) {
                showToast('Seek failed', true);
            }
        }

        function setupSpotifyProgressBar() {
            const track = document.querySelector('.spotify-progress-track');
            const progressBar = document.getElementById('spotify-progress-bar');
            if (!track || !progressBar) return;

            // Dragging fires seekFromEvent on every mousemove — only update the
            // visual bar + pending position there (like the volume slider, which
            // only calls its IPC on mouseup) and send the actual spotifySeek IPC
            // once, on mouseup, instead of once per mousemove.
            let pendingSeekMs = null;

            function seekFromEvent(e) {
                const rect = track.getBoundingClientRect();
                const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const pct = Math.max(0, Math.min(1, x / rect.width));
                if (spotifyCurrentTrack && spotifyCurrentTrack.duration_ms > 0) {
                    const positionMs = Math.round(pct * spotifyCurrentTrack.duration_ms);
                    if (progressBar) progressBar.style.width = (pct * 100) + '%';
                    pendingSeekMs = Math.max(0, Math.min(positionMs, spotifyCurrentTrack.duration_ms));
                }
            }

            track.addEventListener('mousedown', (e) => {
                isDraggingProgress = true;
                if (progressBar) progressBar.style.transition = 'none';
                track.style.cursor = 'grabbing';
                seekFromEvent(e);
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDraggingProgress) return;
                seekFromEvent(e);
            });

            document.addEventListener('mouseup', () => {
                if (isDraggingProgress) {
                    isDraggingProgress = false;
                    if (progressBar) progressBar.style.transition = '';
                    track.style.cursor = 'pointer';
                    if (pendingSeekMs !== null) {
                        spotifySeek(pendingSeekMs);
                        pendingSeekMs = null;
                    }
                }
            });

            track.style.cursor = 'pointer';
        }

        function setupVolumeSlider() {
            const slider = document.getElementById('spotify-volume');
            if (!slider) return;

            const volNum = Number(slider.value);
            const pct = Math.max(0, Math.min(100, volNum));
            slider.style.background = `linear-gradient(to right, var(--accent-solid, #fff) ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;

            slider.addEventListener('mousedown', () => {
                isDraggingVolume = true;
            });

            document.addEventListener('mouseup', () => {
                if (isDraggingVolume) {
                    isDraggingVolume = false;
                    setTimeout(updateSpotifyWidget, 400);
                }
            });
        }

        async function spotifyControl(action) {
            if (!window.electronAPI?.spotifyControl) return;
            try {
                await window.electronAPI.spotifyControl(action);
                setTimeout(updateSpotifyWidget, 200);
            } catch (e) {
                showToast('Spotify control failed', true);
            }
        }

        function spotifyTogglePlay() {
            spotifyControl(spotifyIsPlaying ? 'pause' : 'play');
        }

        let spotifyConnectInProgress = false;

        async function connectSpotify() {
            if (!window.electronAPI?.spotifyAuthStart) {
                showToast('Spotify integration unavailable', true);
                return;
            }
            // The main process also guards against this (authoritative — it's what
            // actually stops a second OAuth window from opening), but guarding here
            // too avoids firing a redundant IPC round-trip on a double-click.
            if (spotifyConnectInProgress) return;
            spotifyConnectInProgress = true;
            showToast('Opening Spotify authorization...');
            try {
                const result = await window.electronAPI.spotifyAuthStart();
                if (result.success) {
                    showToast('Spotify authorized! Connecting...');
                    spotifyConnectionState = 'connecting';
                    spotifyRetryCount = 0;
                    spotifyRetryDelay = 500;
                    await loadSpotifyAuthStatus();
                    startSpotifyPolling();
                } else {
                    spotifyConnectionState = 'error';
                    showToast(result.error || 'Connection failed', true);
                }
            } catch (e) {
                spotifyConnectionState = 'error';
                showToast('Connection failed', true);
                console.error('Spotify auth error:', e);
            } finally {
                spotifyConnectInProgress = false;
            }
        }

        async function disconnectSpotify() {
            if (!window.electronAPI?.spotifyDisconnect) return;
            await window.electronAPI.spotifyDisconnect();
            showToast('Spotify disconnected');
            loadSpotifyAuthStatus();
            stopSpotifyPolling();
            spotifyRetryCount = 0;
            updateSpotifyUI({ connected: false });
        }

        async function saveSpotifyClientId() {
            const input = document.getElementById('spotify-client-id');
            const clientId = input.value.trim();
            if (!clientId) {
                showToast('Please enter a Client ID', true);
                return;
            }
            if (!window.electronAPI?.spotifySaveConfig) return;
            await window.electronAPI.spotifySaveConfig({ clientId });
            showToast('Spotify Client ID saved');
        }

        async function loadSpotifyConfig() {
            if (!window.electronAPI?.spotifyGetConfig) return;
            const config = await window.electronAPI.spotifyGetConfig();
            const input = document.getElementById('spotify-client-id');
            if (input && config.clientId) input.value = config.clientId;
        }

        function openSpotifyDev() {
            if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal('https://developer.spotify.com/dashboard');
            }
        }

        async function loadSpotifyAuthStatus() {
            if (!window.electronAPI?.spotifyAuthStatus) return;
            const status = await window.electronAPI.spotifyAuthStatus();
            const connectBtn = document.getElementById('spotify-connect-btn');
            const disconnectBtn = document.getElementById('spotify-disconnect-btn');
            const statusText = document.getElementById('spotify-auth-status');
            const widgetConnectBtn = document.getElementById('spotify-connect-widget-btn');

            if (status.authenticated) {
                connectBtn?.classList.add('hidden');
                disconnectBtn?.classList.remove('hidden');
                if (statusText) {
                    if (status.displayName) {
                        statusText.innerHTML = `Connected account: <span class="text-white font-medium">${esc(status.displayName)}</span>`;
                        statusText.className = 'text-xs text-green-500';
                    } else {
                        statusText.textContent = 'Authenticated';
                        statusText.className = 'text-xs text-green-500';
                    }
                }
                if (widgetConnectBtn) widgetConnectBtn.classList.add('hidden');
            } else {
                connectBtn?.classList.remove('hidden');
                disconnectBtn?.classList.add('hidden');
                if (statusText) {
                    statusText.textContent = 'Not authenticated';
                    statusText.className = 'text-xs text-neutral-500';
                }
            }
        }

        let spotifyInitialPollTimeout = null;

        function startSpotifyPolling() {
            stopSpotifyPolling();
            spotifyConnectionState = 'connecting';
            spotifyRetryCount = 0;
            spotifyRetryDelay = 500;

            // First attempt after short delay to allow token to fully initialize.
            // Tracked so stopSpotifyPolling() can cancel it — otherwise a disconnect
            // within this 200ms window leaves the timer pending, and it revives
            // polling right after the stop it was supposed to honor.
            spotifyInitialPollTimeout = setTimeout(() => {
                spotifyInitialPollTimeout = null;
                if (!spotifyUpdateInterval) {
                    updateSpotifyWidget();
                    // Poll every 2.5s rather than 1s. Spotify rate-limits (HTTP 429)
                    // ~1s polling, which made playback/lyrics stutter and briefly
                    // "disconnect". The progress bar and lyrics interpolate smoothly
                    // between polls, and user actions (play/pause/skip/seek) still
                    // refresh immediately, so responsiveness is unchanged.
                    spotifyUpdateInterval = setInterval(updateSpotifyWidget, 2500);
                }
            }, 200);
        }

        function stopSpotifyPolling() {
            if (spotifyInitialPollTimeout) {
                clearTimeout(spotifyInitialPollTimeout);
                spotifyInitialPollTimeout = null;
            }
            if (spotifyUpdateInterval) {
                clearInterval(spotifyUpdateInterval);
                spotifyUpdateInterval = null;
            }
            if (spotifyRetryTimeoutHandle) {
                clearTimeout(spotifyRetryTimeoutHandle);
                spotifyRetryTimeoutHandle = null;
            }
        }

        async function initSpotifyWidget() {
            startSpotifyDisk();
            requestAnimationFrame(tickBeatEngine);
            setupSpotifyProgressBar();
            setupVolumeSlider();
            loadDiskSpeed();
            loadLyricsAnticipateDelay();
            loadSpotifyBeatGlowPref();
            loadBeatGlowIntensity();
            await loadSpotifyConfig();
            await loadSpotifyAuthStatus();
            const status = await window.electronAPI?.spotifyAuthStatus?.();
            if (status?.authenticated) startSpotifyPolling();
        }

        window.onload = () => {
            renderApps();
            updateClock();
            applyWidgetPrefs(true); // skip animation on first load -- nothing should flash/animate in or out
            applyAppearance();
            applyMiniWidgetPrefs();
            startPerformanceMonitor();
            updateWeather();
            setInterval(updateWeather, 300000); // 5 mins
            initHotkeys();
            loadSpotifyPrefs();
            loadSpotifyBeatGlowPref();
            loadBeatGlowIntensity();
            initSpotifyWidget();
            applyLyricsPrefs();
            initLyricsPanel();
            if (typeof initTimerWidget === 'function') initTimerWidget();
            // Game Mode: wire the game-launch event stream at startup so profiles
            // apply even when the Widget Library panel is closed.
            if (typeof initGameMode === 'function') initGameMode();

            const notes = document.getElementById('notes');
            const placeholder = document.getElementById('placeholder');
            notes.value = localStorage.getItem('main-notes') || '';
            placeholder.style.opacity = notes.value ? '0' : '1';
            notes.addEventListener('input', () => {
                localStorage.setItem('main-notes', notes.value);
                updateNotesPlaceholder();
            });
            notes.addEventListener('focus', updateNotesPlaceholder);
            notes.addEventListener('blur', updateNotesPlaceholder);

            // Listen for volume adjustments from main process
            if (window.electronAPI?.onSpotifyVolumeAdjust) {
                window.electronAPI.onSpotifyVolumeAdjust((delta) => {
                    spotifyAdjustVolumeBy(delta);
                });
            }

            // Reset the sleep timer UI when the timer elapses on its own (main process paused playback)
            if (window.electronAPI?.onSpotifySleepTimerEnded) {
                window.electronAPI.onSpotifySleepTimerEnded(() => {
                    stopSleepTimerDisplay();
                    renderSleepTimerInactive();
                });
            }

        };

        document.addEventListener('keydown', async e => {
            // PRIORITY: If in binding mode, consume this event immediately
            if (bindingTarget) {
                e.preventDefault();
                e.stopPropagation();

                if (e.key === 'Escape' && bindingTarget !== 'close') {
                    cancelHotkeyBind();
                    showToast('Binding cancelled');
                    return;
                }

                if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

                if (bindingTarget?.startsWith('spotify') && !e.ctrlKey) {
                    showToast('Spotify controls require Ctrl + arrow or page keys', true);
                    cancelHotkeyBind();
                    return;
                }

                const accel = keyEventToAccelerator(e);
                if (!accel) return;

                const type = bindingTarget;
                const btn = document.getElementById(getHotkeyButtonId(type));
                if (btn) btn.classList.remove('listening');

                // Remove this accelerator from any other hotkey to avoid conflicts.
                // Track which categories lost their binding so we can tell the main
                // process to release its own stale registration for each of them —
                // otherwise a category that keeps re-registering its old accelerator
                // on every enable-all-hotkeys cycle can silently steal the key back
                // from whichever category just won it (last globalShortcut.register()
                // for a given accelerator wins).
                const clearedKeys = [];
                for (const [key, value] of Object.entries(hotkeys)) {
                    if (value === accel && key !== type) {
                        hotkeys[key] = '-';
                        clearedKeys.push(key);
                    }
                }

                if (type === 'focus') {
                    if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                        showToast('Focus hotkey needs Ctrl, Alt, or Shift', true);
                        cancelHotkeyBind();
                        return;
                    }
                    const ok = await applyFocusHotkey(accel);
                    if (!ok) {
                        showToast('Hotkey unavailable or in use', true);
                        cancelHotkeyBind();
                        return;
                    }
                    hotkeys.focus = accel;
                } else {
                    hotkeys[type] = accel;
                }

                localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
                bindingTarget = null;
                enableAllHotkeys();
                updateHotkeyDisplays();
                scheduleSettingsSave();

                let spotifyNeedsSync = type.startsWith('spotify');
                let micMuteNeedsSync = type === 'micMute';
                let crosshairNeedsSync = type === 'crosshair';
                let focusNeedsRelease = false;
                for (const key of clearedKeys) {
                    if (key.startsWith('spotify')) spotifyNeedsSync = true;
                    else if (key === 'micMute') micMuteNeedsSync = true;
                    else if (key === 'crosshair') crosshairNeedsSync = true;
                    else if (key === 'focus') focusNeedsRelease = true;
                }
                if (spotifyNeedsSync) await sendSpotifyHotkeysToMain();
                if (micMuteNeedsSync) await sendMicMuteHotkeyToMain();
                if (crosshairNeedsSync) await sendCrosshairHotkeyToMain();
                if (focusNeedsRelease) await releaseFocusHotkeyFromMain();
                showToast('Hotkey updated');
                return;
            }

            // Escape while typing in the Settings search box just exits the search
            // box (clears the filter + drops focus) rather than closing Settings —
            // so a stray Escape doesn't throw away the whole panel.
            if (e.key === 'Escape') {
                const search = document.getElementById('settings-search');
                if (search && document.activeElement === search) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (search.value) { search.value = ''; if (typeof filterSettings === 'function') filterSettings(''); }
                    search.blur();
                    return;
                }
            }

            if (keydownMatches(e, hotkeys.close)) {
                e.preventDefault();
                if (!document.getElementById('settings-modal').classList.contains('hidden')) closeSettingsDone();
                else closeApp();
                return;
            }

            // Type-to-search: while Settings is open, any plain character focuses the
            // search box so you can start filtering without clicking it first. The
            // character then lands in the input naturally (no preventDefault).
            // Suspended while a macro recording runs — those keystrokes belong to
            // the recording, not the search box (see renderer/macros.js).
            if (!document.getElementById('settings-modal').classList.contains('hidden')) {
                const active = document.activeElement;
                const tag = active && active.tagName;
                const alreadyTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable);
                const macroRecording = typeof isMacroRecording === 'function' && isMacroRecording();
                const macroBinding = (typeof isMacroBinding === 'function' && isMacroBinding())
                    || (typeof isControllerMacroBinding === 'function' && isControllerMacroBinding());
                // Also suspended while the Video Editor preview is on screen — its
                // playback hotkeys (Space, etc.) belong to the editor, not the
                // search box (see renderer/video-editor.js).
                const videoEditing = typeof veIsPreviewOnScreen === 'function' && veIsPreviewOnScreen();
                if (!alreadyTyping && !macroRecording && !macroBinding && !videoEditing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const search = document.getElementById('settings-search');
                    if (search) search.focus();
                }
            }

            // Spotify play/pause/next/previous/volume are intentionally NOT handled
            // here — main/spotify.js registers them as OS-global shortcuts via
            // globalShortcut, which fires regardless of window focus. Electron does
            // NOT suppress the keydown from also reaching this focused renderer, so
            // matching them here too would fire every action twice (e.g. skip two
            // tracks instead of one) whenever the app window has focus. Volume
            // changes still reach the UI via the 'spotify-volume-adjust' IPC event
            // sent from main (see onSpotifyVolumeAdjust above).
        }, true);

        // ── LYRICS MANAGEMENT ──
        // The compact panel below builds DOM nodes directly via textContent (not
        // innerHTML), so it's not injection-prone. The full-screen modal still builds
        // its list via innerHTML, so escapeHtml() is kept for that one path.
