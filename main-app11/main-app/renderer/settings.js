        function markSettingsSaving() {
            const status = document.getElementById('settings-save-status');
            const dot = document.getElementById('settings-saved-dot');
            if (status) status.textContent = 'Saving…';
            if (dot) dot.style.opacity = '0.35';
        }

        function markSettingsSaved() {
            const status = document.getElementById('settings-save-status');
            const dot = document.getElementById('settings-saved-dot');
            if (status) status.textContent = 'All changes saved automatically';
            if (dot) dot.style.opacity = '1';
        }

        function persistSettings() {
            localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps));
            localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
            renderApps();
            markSettingsSaved();
        }

        function scheduleSettingsSave() {
            markSettingsSaving();
            clearTimeout(settingsSaveTimer);
            settingsSaveTimer = setTimeout(persistSettings, 350);
        }

        async function openLogFolder() {
            if (window.electronAPI?.openLogFolder) {
                await window.electronAPI.openLogFolder();
                showToast('Log folder opened');
            } else {
                showToast('Log folder unavailable', true);
            }
        }

        function closeSettingsDone() {
            // A hotkey bind in progress disables all global hotkeys (see
            // startHotkeyBind); closing Settings without finishing/cancelling it
            // would leave every hotkey dead with no indication why.
            if (bindingTarget) cancelHotkeyBind();
            clearTimeout(settingsSaveTimer);
            persistSettings();
            document.getElementById('settings-modal').classList.add('hidden');
        }

        function saveSpotifyTimerPref() {
            const selected = document.querySelector('input[name="spotify-timer-mode"]:checked');
            if (selected) localStorage.setItem('spotifyTimerMode', selected.value);
            scheduleSettingsSave();
        }

        function loadSpotifyTimerPref() {
            const mode = localStorage.getItem('spotifyTimerMode') || 'total';
            const radio = document.querySelector(`input[name="spotify-timer-mode"][value="${mode}"]`);
            if (radio) radio.checked = true;
        }

        function saveDiskSpeed() {
            const slider = document.getElementById('spotify-disk-speed');
            const valEl = document.getElementById('spotify-disk-speed-val');
            if (!slider) return;
            const val = parseFloat(slider.value);
            localStorage.setItem('spotifyDiskSpeed', val.toString());
            if (valEl) valEl.textContent = val.toFixed(1);
            const pct = Math.max(0, Math.min(100, ((val - 0.5) / (5.0 - 0.5)) * 100));
            slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            scheduleSettingsSave();
        }

        function loadDiskSpeed() {
            const slider = document.getElementById('spotify-disk-speed');
            const valEl = document.getElementById('spotify-disk-speed-val');
            const stored = parseFloat(localStorage.getItem('spotifyDiskSpeed'));
            const val = isNaN(stored) ? DEFAULT_DISK_SPEED : stored;
            if (slider) {
                slider.value = val;
                const pct = Math.max(0, Math.min(100, ((val - 0.5) / (5.0 - 0.5)) * 100));
                slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            }
            if (valEl) valEl.textContent = val.toFixed(1);
        }

        const DEFAULT_LYRICS_ANTICIPATE_MS = 700;

        function saveLyricsAnticipateDelay() {
            const slider = document.getElementById('lyrics-anticipate-delay');
            const valEl = document.getElementById('lyrics-anticipate-delay-val');
            if (!slider) return;
            const val = parseInt(slider.value, 10);
            localStorage.setItem('lyricsAnticipateMs', val.toString());
            if (valEl) valEl.textContent = (val / 1000).toFixed(1) + 's';
            const pct = Math.max(0, Math.min(100, (val / 2000) * 100));
            slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            scheduleSettingsSave();
        }

        function loadLyricsAnticipateDelay() {
            const slider = document.getElementById('lyrics-anticipate-delay');
            const valEl = document.getElementById('lyrics-anticipate-delay-val');
            const stored = parseInt(localStorage.getItem('lyricsAnticipateMs'), 10);
            const val = isNaN(stored) ? DEFAULT_LYRICS_ANTICIPATE_MS : stored;
            if (slider) {
                slider.value = val;
                const pct = Math.max(0, Math.min(100, (val / 2000) * 100));
                slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            }
            if (valEl) valEl.textContent = (val / 1000).toFixed(1) + 's';
        }

        // Read at the moment it's needed (not cached) so the slider above takes effect
        // immediately, with no "apply"/restart step.
        function getLyricsAnticipateMs() {
            const stored = parseInt(localStorage.getItem('lyricsAnticipateMs'), 10);
            return isNaN(stored) ? DEFAULT_LYRICS_ANTICIPATE_MS : stored;
        }

        let sleepTimerDisplayInterval = null;

        function formatSleepTimerRemaining(endsAt) {
            const ms = endsAt - Date.now();
            if (ms <= 0) return '0:00';
            const totalSec = Math.ceil(ms / 1000);
            const mins = Math.floor(totalSec / 60);
            const secs = totalSec % 60;
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }

        function renderSleepTimerActive(endsAt) {
            document.getElementById('spotify-sleep-timer-start-btn')?.classList.add('hidden');
            document.getElementById('spotify-sleep-timer-cancel-btn')?.classList.remove('hidden');
            const status = document.getElementById('spotify-sleep-timer-status');
            if (status) status.textContent = `Playback pauses in ${formatSleepTimerRemaining(endsAt)}`;
        }

        function renderSleepTimerInactive() {
            document.getElementById('spotify-sleep-timer-start-btn')?.classList.remove('hidden');
            document.getElementById('spotify-sleep-timer-cancel-btn')?.classList.add('hidden');
            const status = document.getElementById('spotify-sleep-timer-status');
            if (status) status.textContent = 'Pauses playback automatically after the selected time.';
        }

        function stopSleepTimerDisplay() {
            if (sleepTimerDisplayInterval) clearInterval(sleepTimerDisplayInterval);
            sleepTimerDisplayInterval = null;
        }

        function startSleepTimerDisplay(endsAt) {
            stopSleepTimerDisplay();
            renderSleepTimerActive(endsAt);
            sleepTimerDisplayInterval = setInterval(() => {
                if (Date.now() >= endsAt) {
                    stopSleepTimerDisplay();
                    renderSleepTimerInactive();
                    return;
                }
                renderSleepTimerActive(endsAt);
            }, 1000);
        }

        async function startSpotifySleepTimer() {
            const select = document.getElementById('spotify-sleep-timer-select');
            const minutes = parseInt(select?.value, 10) || 30;
            const result = await window.electronAPI?.startSpotifySleepTimer(minutes);
            if (result?.active) startSleepTimerDisplay(result.endsAt);
        }

        async function cancelSpotifySleepTimer() {
            await window.electronAPI?.cancelSpotifySleepTimer();
            stopSleepTimerDisplay();
            renderSleepTimerInactive();
        }

        async function refreshSleepTimerUI() {
            const status = await window.electronAPI?.getSpotifySleepTimerStatus();
            if (status?.active) startSleepTimerDisplay(status.endsAt);
            else {
                stopSleepTimerDisplay();
                renderSleepTimerInactive();
            }
        }

        function saveSpotifyPrefs() {
            const enabled = document.getElementById('spotify-autoplay').checked;
            localStorage.setItem('spotifyAutoPlay', enabled ? 'true' : 'false');
            document.getElementById('spotify-delay-options').classList.toggle('hidden', !enabled);
            const selected = document.querySelector('input[name="spotify-delay"]:checked');
            if (selected) localStorage.setItem('spotifyAutoPlayDelay', selected.value);
            scheduleSettingsSave();
        }

        function loadSpotifyPrefs() {
            const checkbox = document.getElementById('spotify-autoplay');
            if (!checkbox) return;
            const enabled = localStorage.getItem('spotifyAutoPlay') === 'true';
            checkbox.checked = enabled;
            document.getElementById('spotify-delay-options').classList.toggle('hidden', !enabled);
            const delay = localStorage.getItem('spotifyAutoPlayDelay') || '2800';
            const radio = document.querySelector(`input[name="spotify-delay"][value="${delay}"]`);
            if (radio) radio.checked = true;
        }

        function saveSpotifyBeatGlowPref() {
            const checkbox = document.getElementById('spotify-beat-glow-checkbox');
            if (!checkbox) return;
            localStorage.setItem('spotifyBeatGlow', checkbox.checked ? 'true' : 'false');
            document.getElementById('spotify-beat-glow-options')?.classList.toggle('hidden', !checkbox.checked);
            if (!checkbox.checked) {
                stopLiveAudioAnalyser();
                beatEngineState.mode = 'none';
                resetBeatGlowVisuals();
                updateBeatSyncStatus('Beat sync: disabled');
            } else if (spotifyIsPlaying && spotifyCurrentTrack?.id) {
                loadBeatDataForTrack(spotifyCurrentTrack.id);
            } else {
                updateBeatSyncStatus('Beat sync: waiting for music…');
            }
            scheduleSettingsSave();
        }

        function loadSpotifyBeatGlowPref() {
            const checkbox = document.getElementById('spotify-beat-glow-checkbox');
            if (!checkbox) return;
            const stored = localStorage.getItem('spotifyBeatGlow');
            checkbox.checked = stored !== 'false';
            document.getElementById('spotify-beat-glow-options')?.classList.toggle('hidden', !checkbox.checked);
        }

        function isBeatGlowEnabled() {
            return localStorage.getItem('spotifyBeatGlow') !== 'false';
        }

        function updateBeatSyncStatus(text) {
            const el = document.getElementById('spotify-beat-status');
            if (el && el.textContent !== text) el.textContent = text;
        }

        const DEFAULT_BEAT_GLOW_INTENSITY = 1;

        function getBeatGlowIntensity() {
            const stored = parseFloat(localStorage.getItem('spotifyBeatGlowIntensity'));
            if (isNaN(stored)) return DEFAULT_BEAT_GLOW_INTENSITY;
            return Math.min(3, Math.max(0.5, stored));
        }

        function saveBeatGlowIntensity() {
            const slider = document.getElementById('spotify-beat-glow-intensity');
            const valEl = document.getElementById('spotify-beat-glow-intensity-val');
            if (!slider) return;
            const val = parseFloat(slider.value);
            localStorage.setItem('spotifyBeatGlowIntensity', val.toString());
            if (valEl) valEl.textContent = `${Math.round(val * 100)}%`;
            const pct = Math.max(0, Math.min(100, ((val - 0.5) / (3 - 0.5)) * 100));
            slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            scheduleSettingsSave();
        }

        function loadBeatGlowIntensity() {
            const slider = document.getElementById('spotify-beat-glow-intensity');
            const valEl = document.getElementById('spotify-beat-glow-intensity-val');
            const stored = parseFloat(localStorage.getItem('spotifyBeatGlowIntensity'));
            const val = isNaN(stored) ? DEFAULT_BEAT_GLOW_INTENSITY : Math.min(3, Math.max(0.5, stored));
            if (slider) {
                slider.value = val;
                const pct = Math.max(0, Math.min(100, ((val - 0.5) / (3 - 0.5)) * 100));
                slider.style.background = `linear-gradient(to right, #fff ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
            }
            if (valEl) valEl.textContent = `${Math.round(val * 100)}%`;
        }

        function toggleSpotifyExtras(forceCollapsed) {
            const content = document.getElementById('spotify-extras-content');
            const toggleBtn = document.getElementById('spotify-extras-toggle');
            if (!content || !toggleBtn) return;
            const collapsed = typeof forceCollapsed === 'boolean' ? forceCollapsed : !content.classList.contains('hidden');
            content.classList.toggle('hidden', collapsed);
            toggleBtn.classList.toggle('extras-collapsed', collapsed);
            localStorage.setItem('spotifyExtrasCollapsed', collapsed ? 'true' : 'false');
        }

        function loadSpotifyExtrasCollapsed() {
            const collapsed = localStorage.getItem('spotifyExtrasCollapsed') === 'true';
            toggleSpotifyExtras(collapsed);
        }

        function saveVisualizerPref() {
            const checkbox = document.getElementById('spotify-visualizer-checkbox');
            if (!checkbox) return;
            localStorage.setItem('spotifyVisualizerEnabled', checkbox.checked ? 'true' : 'false');
            document.getElementById('spotify-visualizer-options')?.classList.toggle('hidden', !checkbox.checked);
            const selected = document.querySelector('input[name="spotify-visualizer-mode"]:checked');
            if (selected) localStorage.setItem('spotifyVisualizerMode', selected.value);
            if (typeof applyVisualizerPrefs === 'function') applyVisualizerPrefs();
            scheduleSettingsSave();
        }

        function loadVisualizerPref() {
            const checkbox = document.getElementById('spotify-visualizer-checkbox');
            if (!checkbox) return;
            const enabled = localStorage.getItem('spotifyVisualizerEnabled') === 'true';
            checkbox.checked = enabled;
            document.getElementById('spotify-visualizer-options')?.classList.toggle('hidden', !enabled);
            const mode = localStorage.getItem('spotifyVisualizerMode') || 'circular';
            const radio = document.querySelector(`input[name="spotify-visualizer-mode"][value="${mode}"]`);
            if (radio) radio.checked = true;
        }

        function isVisualizerEnabled() {
            return localStorage.getItem('spotifyVisualizerEnabled') === 'true';
        }

        function getVisualizerMode() {
            return localStorage.getItem('spotifyVisualizerMode') || 'circular';
        }

        function saveFpsDisplayMode() {
            const mode = document.getElementById('fps-display-mode').value;
            localStorage.setItem('fpsDisplayMode', mode);
            scheduleSettingsSave();
        }

        function loadFpsDisplayMode() {
            const mode = localStorage.getItem('fpsDisplayMode') || 'sidepanel';
            const select = document.getElementById('fps-display-mode');
            if (select) select.value = mode;
        }

        function saveClockFormat() {
            const selected = document.querySelector('input[name="clock-format"]:checked');
            if (selected) localStorage.setItem('clockFormat', selected.value);
            scheduleSettingsSave();
        }

        function loadClockFormat() {
            const format = localStorage.getItem('clockFormat') || '12';
            const radio = document.querySelector(`input[name="clock-format"][value="${format}"]`);
            if (radio) radio.checked = true;
        }

        function saveWeatherUnit() {
            const selected = document.querySelector('input[name="weather-unit"]:checked');
            if (selected) localStorage.setItem('weatherUnit', selected.value);
            scheduleSettingsSave();
            updateWeather();
        }

        function loadWeatherUnit() {
            const unit = localStorage.getItem('weatherUnit') || 'C';
            const radio = document.querySelector(`input[name="weather-unit"][value="${unit}"]`);
            if (radio) radio.checked = true;
        }

        // Display Monitor — persisted in the main process (not localStorage), since it
        // needs Electron's screen module and BrowserWindow positioning to apply.
        async function loadDisplayMonitorSetting() {
            if (!window.electronAPI?.getDisplays) return;
            const select = document.getElementById('display-monitor-select');
            if (!select) return;
            try {
                const [displays, selectedId] = await Promise.all([
                    window.electronAPI.getDisplays(),
                    window.electronAPI.getSelectedDisplay()
                ]);
                select.innerHTML = displays.map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
                select.value = String(selectedId);
            } catch (e) {
                console.error('Failed to load display monitor setting', e);
            }
        }

        async function saveDisplayMonitor() {
            const select = document.getElementById('display-monitor-select');
            if (!select || !window.electronAPI?.setSelectedDisplay) return;
            await window.electronAPI.setSelectedDisplay(Number(select.value));
            scheduleSettingsSave();
        }

