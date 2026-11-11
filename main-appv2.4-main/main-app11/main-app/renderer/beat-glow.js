        // A corrupt stored value used to survive as NaN, which makes every
        // `rotate(NaNdeg)` invalid — the vinyl silently never turns again, and
        // nothing says why. Fall back to 0 instead.
        let spotifyDiskAngle = parseFloat(localStorage.getItem('spotifyDiskAngle') || '0');
        if (!Number.isFinite(spotifyDiskAngle)) spotifyDiskAngle = 0;
        let spotifyDiskVelocity = 0;
        let spotifyTargetVelocity = 0;
        // Whether the glow visuals are already in their cleared state.
        // resetBeatGlowVisuals() is idempotent, which is exactly why it ended up
        // being called on every frame of the idle loop: two getElementById
        // lookups and three style writes per frame, to set values that were
        // already set, whenever nothing was playing — which is most of the time.
        // It only has to run on the way INTO idle, and this is what remembers
        // that it has. Set by resetBeatGlowVisuals() itself, so it stays true
        // whichever caller does the clearing.
        let beatGlowIdle = false;
        let spotifyIsPlaying = false;
        let spotifyCurrentTrack = null;
        let spotifyUpdateInterval = null;
        let isDraggingProgress = false;
        let isDraggingVolume = false;
        let lastVolumeChangeTime = 0;
        const DEFAULT_DISK_SPEED = 1.8;
        const DISK_ACCEL = 0.08;
        const DISK_DECEL = 0.015;
        let spotifyConnectionState = 'idle'; // idle, connecting, connected, error
        let spotifyRetryCount = 0;
        let spotifyRetryDelay = 500;
        let spotifyRetryTimeoutHandle = null;

        const BEAT_MIN_CONFIDENCE = 0.3;
        const BEAT_SEGMENT_LOUDNESS = -20;
        const BEAT_WINDOW_MS = 80;
        const BEAT_GLOW_DECAY = 0.88;

        let beatGlowLevel = 0;
        // Spotify retired its /audio-analysis and /audio-features endpoints (they now
        // return HTTP 403), so the only way to make the glow react to the ACTUAL music
        // is to listen to the PC's own audio output (loopback) and detect the bass.
        // We do that with the Web Audio API on a loopback capture stream. This is CPU
        // work (an FFT), independent of GPU acceleration, so it stays stable even with
        // hardware acceleration disabled. Lifecycle is important: we start the capture
        // ONCE and reuse it across track changes (the earlier version restarted it on
        // every track, which was wasteful), and stop it when playback pauses/stops or
        // Beat Glow is turned off. If capture is unavailable, we fall back to a gentle
        // ambient pulse (updateSimBeat) so the disk still feels alive.
        let liveAudio = { stream: null, context: null, analyser: null, data: null, avg: 0, cooldown: 0, starting: false };
        // Some machines' audio devices/WebAudio renderer repeatedly error out of the
        // loopback capture ("The AudioContext encountered an error from the audio
        // device or the WebAudio renderer"). Re-opening the capture on every track
        // change then thrashes the audio service, which on those devices can escalate
        // to a renderer crash (STATUS_STACK_BUFFER_OVERRUN). Once loopback capture has
        // failed or errored this session, latch this flag so we stay on the ambient
        // pulse instead of re-spinning it. Cleared only by restarting the app.
        let liveAudioUnsupported = false;
        let beatEngineState = {
            trackId: null,
            mode: 'none',
            events: [],
            nextEventIndex: 0,
            tempo: 0,
            lastBpmBeatIndex: -1,
            progressMs: 0,
            lastProgressMs: 0,
            lastProgressAt: 0,
            isPlaying: false,
            loadingTrackId: null
        };

        // Ambient fallback pulse. With no real beat data available (Spotify's analysis
        // API is gone and we no longer capture audio), drive a slow, smooth "breathing"
        // glow off the track's own playback position so the disk still feels alive.
        // Nothing here touches media/GPU capture, so it cannot crash the renderer.
        // Amplitude stays low and is still scaled by the user's Beat Glow Intensity
        // slider inside applyBeatGlowVisual().
        function updateSimBeat(progressMs) {
            const cycleMs = 1500;
            const phase = (((progressMs % cycleMs) + cycleMs) % cycleMs) / cycleMs; // 0..1
            const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;                    // smooth 0..1..0
            beatGlowLevel = Math.max(beatGlowLevel, wave * 0.5);
        }

        // Tear down the loopback capture and release the audio context/stream.
        function stopLiveAudioAnalyser() {
            try { liveAudio.stream?.getTracks().forEach((t) => t.stop()); } catch (e) { }
            try { if (liveAudio.context) liveAudio.context.close().catch(() => { }); } catch (e) { }
            liveAudio = { stream: null, context: null, analyser: null, data: null, avg: 0, cooldown: 0, starting: false };
        }

        // Start (or reuse) a loopback capture of the PC's audio output and wire it into
        // a Web Audio analyser. Returns true when a live analyser is available. The main
        // process auto-approves the display-media request with loopback audio, so no
        // permission dialog appears. Video is requested at 1x1 and immediately dropped —
        // we only want the audio.
        async function ensureLiveAudioAnalyser() {
            if (liveAudio.analyser) return true;
            if (liveAudioUnsupported) return false; // errored earlier this session — stay on ambient
            if (liveAudio.starting) return false;
            liveAudio.starting = true;
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: 1, height: 1, frameRate: 1 },
                    audio: true
                });
                stream.getVideoTracks().forEach((t) => t.stop());
                const audioTracks = stream.getAudioTracks();
                if (!audioTracks.length) {
                    stream.getTracks().forEach((t) => t.stop());
                    liveAudio.starting = false;
                    liveAudioUnsupported = true; // no loopback audio device — don't keep retrying
                    return false;
                }
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.4;
                audioContext.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
                liveAudio.stream = stream;
                liveAudio.context = audioContext;
                liveAudio.analyser = analyser;
                liveAudio.data = new Uint8Array(analyser.frequencyBinCount);
                liveAudio.avg = 0;
                liveAudio.cooldown = 0;
                liveAudio.starting = false;
                // If the user stops sharing from the OS, drop back to the ambient pulse.
                audioTracks[0].addEventListener('ended', () => {
                    stopLiveAudioAnalyser();
                    if (beatEngineState.mode === 'live') beatEngineState.mode = 'sim';
                });
                // Same if the audio device / WebAudio renderer errors out mid-stream
                // (seen as "The AudioContext encountered an error" on some devices) —
                // otherwise the mode would stay 'live' with a dead analyser and the
                // glow would silently freeze. An unexpected close/interrupt here is the
                // audio-device fault that precedes the renderer crash, so latch
                // liveAudioUnsupported to stop re-opening the capture this session.
                audioContext.onstatechange = () => {
                    if (liveAudio.context !== audioContext) return; // already torn down
                    const st = audioContext.state;
                    if (st === 'closed' || st === 'interrupted') {
                        liveAudioUnsupported = true;
                        stopLiveAudioAnalyser();
                        if (beatEngineState.mode === 'live') beatEngineState.mode = 'sim';
                        updateBeatSyncStatus('Beat sync: ambient pulse');
                    }
                };
                updateBeatSyncStatus('Beat sync: live audio (reacting to PC sound)');
                return true;
            } catch (e) {
                console.warn('Live audio capture unavailable', e);
                liveAudio.starting = false;
                liveAudioUnsupported = true; // capture threw — fall back to ambient for the session
                return false;
            }
        }

        // One analysis tick: read the low-frequency (bass) bins, keep a running average,
        // and fire a beat pulse when the current bass clearly exceeds that average.
        function checkLiveAudioBeat() {
            if (!liveAudio.analyser || !liveAudio.data) return;
            liveAudio.analyser.getByteFrequencyData(liveAudio.data);
            let bass = 0;
            const bins = Math.min(10, liveAudio.data.length);
            for (let i = 1; i < bins; i++) bass += liveAudio.data[i];
            bass /= Math.max(1, bins - 1);
            liveAudio.avg = liveAudio.avg * 0.92 + bass * 0.08;
            liveAudio.cooldown = Math.max(0, liveAudio.cooldown - 1);
            const threshold = Math.max(24, liveAudio.avg * 1.22);
            if (liveAudio.cooldown === 0 && bass > threshold && bass > 32) {
                // Scale pulse strength by how far above the average this beat is.
                const strength = Math.min(1, (bass - liveAudio.avg) / 90 + 0.4);
                triggerBeatPulse(strength);
                liveAudio.cooldown = 6;
            }
        }

        // ── Reading a setting on the animation path ──
        // isBeatGlowEnabled() and getBeatGlowIntensity() both go to
        // localStorage, and both were being called from inside a 60fps loop that
        // never stops — a synchronous storage read plus a parseFloat, ~120 times
        // a second, forever, on an always-on launcher. Nobody changes a slider 60
        // times a second, so the values are cached and re-read four times a
        // second instead. A quarter second is imperceptible while dragging the
        // intensity slider, and it is two orders of magnitude less work.
        const SETTING_CACHE_MS = 250;
        let settingCacheAt = 0;
        let cachedGlowEnabled = true;
        let cachedGlowIntensity = 1;

        function refreshGlowSettings(now) {
            if (now - settingCacheAt < SETTING_CACHE_MS) return;
            settingCacheAt = now;
            cachedGlowEnabled = isBeatGlowEnabled();
            cachedGlowIntensity = getBeatGlowIntensity();
        }

        function resetBeatGlowVisuals() {
            beatGlowLevel = 0;
            beatGlowIdle = true;
            const halo = document.getElementById('spotify-beat-glow');
            const disk = document.getElementById('spotify-disk');
            if (halo) {
                halo.style.opacity = '0';
                halo.style.transform = 'scale(1)';
            }
            if (disk) disk.style.filter = '';
        }

        function applyBeatGlowVisual(intensity) {
            const halo = document.getElementById('spotify-beat-glow');
            const disk = document.getElementById('spotify-disk');
            if (!halo || !disk) return;
            // Cached rather than read from localStorage on every frame — see
            // refreshGlowSettings() below. Falls back to a live read for the
            // callers that are not on the animation path.
            const mult = settingCacheAt ? cachedGlowIntensity : getBeatGlowIntensity();
            const i = Math.min(1, Math.max(0, intensity * mult));
            if (i <= 0.02) {
                halo.style.opacity = '0';
                halo.style.transform = 'scale(1)';
                disk.style.filter = '';
                return;
            }
            halo.style.opacity = (0.15 + i * 0.55).toFixed(3);
            halo.style.transform = `scale(${(1 + i * 0.35 * mult).toFixed(3)})`;
            const glow1 = 4 + i * 18 * mult;
            const glow2 = 8 + i * 28 * mult;
            const alpha1 = Math.min(0.65, 0.12 + i * 0.32 * mult).toFixed(3);
            const alpha2 = Math.min(0.4, 0.06 + i * 0.18 * mult).toFixed(3);
            // Follows the accent theme (Settings → Background) — bgAccentRgbStr is
            // kept current by renderer/background.js; white when unthemed.
            const beatRgb = typeof bgAccentRgbStr === 'string' ? bgAccentRgbStr : '255, 255, 255';
            disk.style.filter = `drop-shadow(0 0 ${glow1.toFixed(1)}px rgba(${beatRgb},${alpha1})) drop-shadow(0 0 ${glow2.toFixed(1)}px rgba(${beatRgb},${alpha2}))`;
        }

        function triggerBeatPulse(strength) {
            const mult = getBeatGlowIntensity();
            beatGlowLevel = Math.min(1, beatGlowLevel + Math.min(1, Math.max(0.35, strength)) * 0.9 * mult);
        }

        function buildBeatEvents(analysis) {
            const events = [];
            const beatTimes = new Set();

            if (Array.isArray(analysis?.beats)) {
                for (const beat of analysis.beats) {
                    if ((beat.confidence ?? 0) >= BEAT_MIN_CONFIDENCE) {
                        const timeMs = beat.start * 1000;
                        events.push({ timeMs, strength: beat.confidence, type: 'beat' });
                        beatTimes.add(Math.round(timeMs / 50));
                    }
                }
            }

            if (Array.isArray(analysis?.segments)) {
                for (const segment of analysis.segments) {
                    if ((segment.loudness_max ?? -60) >= BEAT_SEGMENT_LOUDNESS) {
                        const timeMs = (segment.start + (segment.loudness_max_time || 0)) * 1000;
                        const bucket = Math.round(timeMs / 50);
                        if (beatTimes.has(bucket) || beatTimes.has(bucket - 1) || beatTimes.has(bucket + 1)) continue;
                        const strength = Math.min(1, Math.max(0.4, (segment.loudness_max + 35) / 15));
                        events.push({ timeMs, strength, type: 'segment' });
                    }
                }
            }

            events.sort((a, b) => a.timeMs - b.timeMs);
            return events;
        }

        function syncBeatEngineProgressIndex(progressMs) {
            const events = beatEngineState.events;
            if (!events.length) return;
            let idx = 0;
            while (idx < events.length && events[idx].timeMs < progressMs - BEAT_WINDOW_MS) idx++;
            beatEngineState.nextEventIndex = idx;
        }

        function checkBeatEvents(progressMs) {
            const events = beatEngineState.events;
            while (beatEngineState.nextEventIndex < events.length) {
                const event = events[beatEngineState.nextEventIndex];
                if (event.timeMs > progressMs) break;
                triggerBeatPulse(event.strength);
                beatEngineState.nextEventIndex++;
            }
        }

        function checkBpmBeat(progressMs) {
            const tempo = beatEngineState.tempo;
            if (!tempo || tempo <= 0) return;
            const beatIntervalMs = 60000 / tempo;
            const beatIndex = Math.floor(progressMs / beatIntervalMs);
            if (beatIndex > beatEngineState.lastBpmBeatIndex) {
                beatEngineState.lastBpmBeatIndex = beatIndex;
                triggerBeatPulse(0.55);
            }
        }

        async function loadBeatDataForTrack(trackId) {
            if (!trackId) return;
            if (beatEngineState.loadingTrackId === trackId) return;
            beatEngineState.loadingTrackId = trackId;
            beatEngineState.mode = 'none';
            beatEngineState.events = [];
            beatEngineState.nextEventIndex = 0;
            beatEngineState.lastBpmBeatIndex = -1;
            beatEngineState.tempo = 0;
            updateBeatSyncStatus('Beat sync: loading…');

            // Spotify's /audio-analysis and /audio-features endpoints are permanently
            // retired (HTTP 403 for every app since Nov 2024), so don't probe them —
            // every request is a guaranteed failure and an error-log entry. Go straight
            // to the live PC-audio listener (or the ambient pulse fallback).
            await useLiveAudioOrAmbient();
        }

        // Prefer reacting to the PC's real audio output; fall back to the ambient pulse
        // if loopback capture isn't available (blocked, or no audio device).
        async function useLiveAudioOrAmbient() {
            beatEngineState.loadingTrackId = null;
            if (!isBeatGlowEnabled()) { beatEngineState.mode = 'none'; return; }
            const ok = await ensureLiveAudioAnalyser();
            beatEngineState.mode = ok ? 'live' : 'sim';
            if (!ok) updateBeatSyncStatus('Beat sync: ambient pulse');
        }

        function updateBeatEngineFromPlayback(data) {
            if (!data?.track) {
                beatEngineState.isPlaying = false;
                beatEngineState.trackId = null;
                beatEngineState.mode = 'none';
                beatEngineState.loadingTrackId = null;
                stopLiveAudioAnalyser();
                resetBeatGlowVisuals();
                if (isBeatGlowEnabled()) updateBeatSyncStatus('Beat sync: waiting for music…');
                return;
            }

            const progressMs = data.track.progress_ms || 0;
            const progressJump = Math.abs(progressMs - beatEngineState.lastProgressMs);
            if (progressJump > 1500) syncBeatEngineProgressIndex(progressMs);
            if (progressMs < beatEngineState.lastProgressMs - 500) {
                syncBeatEngineProgressIndex(progressMs);
                if (beatEngineState.mode === 'bpm' && beatEngineState.tempo > 0) {
                    beatEngineState.lastBpmBeatIndex = Math.floor(progressMs / (60000 / beatEngineState.tempo)) - 1;
                }
            }

            beatEngineState.isPlaying = !!data.is_playing;
            beatEngineState.progressMs = progressMs;
            beatEngineState.lastProgressMs = progressMs;
            beatEngineState.lastProgressAt = Date.now();

            // Release the loopback capture whenever playback isn't actively running.
            if (!data.is_playing) stopLiveAudioAnalyser();

            if (data.track.id && data.track.id !== beatEngineState.trackId) {
                // New track: keep the existing capture (reuse — no churn), just refresh mode.
                beatEngineState.trackId = data.track.id;
                if (isBeatGlowEnabled()) loadBeatDataForTrack(data.track.id);
            } else if (isBeatGlowEnabled() && data.is_playing && beatEngineState.mode === 'live' && !liveAudio.analyser) {
                // Resumed after a pause — restart the capture we released above.
                ensureLiveAudioAnalyser();
            }
        }

        function updateInterpolatedSpotifyProgress() {
            if (!spotifyIsPlaying || !spotifyCurrentTrack?.duration_ms) return;
            let progressMs = beatEngineState.progressMs;
            if (beatEngineState.lastProgressAt) {
                progressMs += Date.now() - beatEngineState.lastProgressAt;
            }
            progressMs = Math.min(spotifyCurrentTrack.duration_ms, Math.max(0, progressMs));
            const progressBar = document.getElementById('spotify-progress-bar');
            const timeCurrent = document.getElementById('spotify-time-current');
            if (progressBar && !isDraggingProgress) {
                progressBar.style.width = `${(progressMs / spotifyCurrentTrack.duration_ms) * 100}%`;
            }
            if (timeCurrent) timeCurrent.textContent = formatMsTime(progressMs);
        }

        function tickBeatEngine() {
            refreshGlowSettings(Date.now());
            if (cachedGlowEnabled && beatEngineState.isPlaying) {
                beatGlowIdle = false;
                let progressMs = beatEngineState.progressMs;
                if (beatEngineState.lastProgressAt) {
                    progressMs += Date.now() - beatEngineState.lastProgressAt;
                }
                if (beatEngineState.mode === 'analysis') checkBeatEvents(progressMs);
                else if (beatEngineState.mode === 'bpm') checkBpmBeat(progressMs);
                else if (beatEngineState.mode === 'live') checkLiveAudioBeat();
                else if (beatEngineState.mode === 'sim') updateSimBeat(progressMs);
                beatGlowLevel *= BEAT_GLOW_DECAY;
                beatGlowLevel = beatGlowLevel < 0.01 ? 0 : beatGlowLevel;
                applyBeatGlowVisual(beatGlowLevel);
                updateInterpolatedSpotifyProgress();
            } else {
                if (beatGlowLevel > 0.01) {
                    beatGlowLevel *= BEAT_GLOW_DECAY;
                    applyBeatGlowVisual(beatGlowLevel);
                    beatGlowIdle = false;
                } else if (!beatGlowIdle) {
                    // The frame the glow finishes fading out — clear once, then
                    // let every following idle frame do nothing at all.
                    beatGlowLevel = 0;
                    resetBeatGlowVisuals();
                    beatGlowIdle = true;
                }
            }
            requestAnimationFrame(tickBeatEngine);
        }

        function getDiskMaxSpeed() {
            const stored = parseFloat(localStorage.getItem('spotifyDiskSpeed'));
            return isNaN(stored) ? DEFAULT_DISK_SPEED : stored;
        }

        // The vinyl eases to a stop rather than snapping, so the velocity only
        // ever APPROACHES zero — it never reaches it. Left alone that means the
        // disk is technically still turning by a millionth of a degree a frame
        // for the rest of the session, and the loop goes on writing a transform
        // for it. Below this it is neither visible nor worth a frame of work.
        const DISK_STOPPED = 0.0005;
        let diskEl = null;
        let diskStopped = false;
        let diskAngleSaved = spotifyDiskAngle;

        function paintDisk() {
            // Cached: the same element was being resolved by id 60 times a
            // second. Re-resolved if it is replaced, or not rendered yet.
            if (!diskEl || !diskEl.isConnected) diskEl = document.getElementById('spotify-disk');
            if (diskEl) diskEl.style.transform = `rotate(${spotifyDiskAngle}deg)`;
        }

        function animateSpotifyDisk() {
            const factor = spotifyTargetVelocity > 0 ? DISK_ACCEL : DISK_DECEL;
            spotifyDiskVelocity += (spotifyTargetVelocity - spotifyDiskVelocity) * factor;

            if (spotifyTargetVelocity <= 0 && Math.abs(spotifyDiskVelocity) < DISK_STOPPED) {
                // Parked. Snap the residue away and paint the resting angle ONCE
                // — that final write is also what restores the saved angle on a
                // cold start, when the disk is stationary from the first frame.
                // Every following idle frame then does nothing at all: no lookup,
                // no style write, no layout.
                if (!diskStopped) {
                    spotifyDiskVelocity = 0;
                    diskStopped = true;
                    paintDisk();
                }
            } else {
                diskStopped = false;
                spotifyDiskAngle = (spotifyDiskAngle + spotifyDiskVelocity) % 360;
                paintDisk();
            }

            requestAnimationFrame(animateSpotifyDisk);
        }

        let diskStarted = false;

        function startSpotifyDisk() {
            // Two rAF loops driving one angle would race and double the speed.
            if (diskStarted) return;
            diskStarted = true;
            requestAnimationFrame(animateSpotifyDisk);
            // Persist the angle so the vinyl picks up where it left off — but
            // only when it has actually moved. A paused launcher was writing the
            // same string to localStorage every two seconds indefinitely.
            setInterval(() => {
                if (spotifyDiskAngle === diskAngleSaved) return;
                diskAngleSaved = spotifyDiskAngle;
                localStorage.setItem('spotifyDiskAngle', spotifyDiskAngle.toString());
            }, 2000);
        }

        let isSpotifyUpdating = false;
        let spotifyUpdateQueued = false;

        async function updateSpotifyWidget() {
            if (isSpotifyUpdating) {
                spotifyUpdateQueued = true;
                return;
            }
            isSpotifyUpdating = true;
            spotifyUpdateQueued = false;
            try {
                const data = await window.electronAPI.spotifyGetCurrentTrack();
                if (data) {
                    // Success - track data received or connected status known
                    if (data.connected === false) {
                        // Token issue or not authenticated
                        spotifyRetryCount++;
                        if (spotifyRetryCount < 8) {
                            // Retry with exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 32s.
                            // Tracked so stopSpotifyPolling() can cancel it explicitly —
                            // checking `spotifyUpdateInterval` alone isn't enough, since a
                            // disconnect+reconnect within the backoff window leaves that
                            // truthy again (a new polling session's interval), letting a
                            // stale retry from the OLD session fire into the new one.
                            spotifyRetryDelay = Math.min(32000, spotifyRetryDelay * 2);
                            if (spotifyRetryTimeoutHandle) clearTimeout(spotifyRetryTimeoutHandle);
                            spotifyRetryTimeoutHandle = setTimeout(() => {
                                spotifyRetryTimeoutHandle = null;
                                if (spotifyUpdateInterval) updateSpotifyWidget();
                            }, spotifyRetryDelay);
                            showToast('Spotify: Waiting for connection...', false);
                            return;
                        }
                    } else {
                        // Connected state achieved
                        spotifyRetryCount = 0;
                        spotifyRetryDelay = 500;
                        spotifyConnectionState = 'connected';
                    }
                    updateSpotifyUI(data);
                } else {
                    console.warn('Spotify widget update: No data returned');
                }
            } catch (e) {
                console.error('Spotify update failed', e);
                spotifyRetryCount++;
                if (spotifyRetryCount >= 8) {
                    spotifyConnectionState = 'error';
                }
            } finally {
                isSpotifyUpdating = false;
                if (spotifyUpdateQueued) {
                    spotifyUpdateQueued = false;
                    updateSpotifyWidget();
                }
            }
        }
