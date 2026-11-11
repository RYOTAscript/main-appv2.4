        // ── Corner Player ───────────────────────────────────────────────────
        // A tiny always-on-top Spotify player that tucks into a screen corner,
        // with an optional live lyric line. main/miniPlayer.js owns the window
        // and polls Spotify itself — this window's timers throttle while it sits
        // hidden in the tray, which is exactly when the corner player is on
        // screen. This file is only the Widget Library panel, plus the two
        // things main can't see on its own: the accent colour and the lyrics
        // timing offset.

        let miniPlayerPrefs = null;

        // Called from applyMiniWidgetPrefs() when the widget toggle flips (and on
        // boot). Main remembers the rest of the settings itself.
        function applyMiniPlayerEnabled(enabled) {
            if (!window.electronAPI?.miniPlayerSetEnabled) return;
            window.electronAPI.miniPlayerSetEnabled(!!enabled).then((p) => {
                if (p && typeof p === 'object' && 'enabled' in p) miniPlayerPrefs = p;
                renderMiniPlayerPanel();
            }).catch(() => {});
            if (enabled) pushMiniPlayerSync();
        }

        // The accent colour (renderer/background.js) and the "Lyrics Timing"
        // offset (renderer/settings.js), so the corner player glows in the
        // same colour and shows the same lyric line as the launcher.
        function pushMiniPlayerSync() {
            if (!window.electronAPI?.miniPlayerSync) return;
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-solid').trim();
            const anticipateMs = typeof getLyricsAnticipateMs === 'function' ? getLyricsAnticipateMs() : 700;
            window.electronAPI.miniPlayerSync({ accent, anticipateMs }).catch(() => {});
        }

        async function setMiniPlayerPref(key, value) {
            if (!window.electronAPI?.miniPlayerSetPrefs) return;
            const patch = { [key]: key === 'lyrics' ? value === 'on' : value };
            try {
                const p = await window.electronAPI.miniPlayerSetPrefs(patch);
                if (p && typeof p === 'object' && 'enabled' in p) miniPlayerPrefs = p;
            } catch (e) { /* main logs it */ }
            renderMiniPlayerPanel();
        }

        // ── Config panel (Widget Library detail view) ───────────────────────────
        // No-ops unless its div is on screen (only present while the detail is open).
        function renderMiniPlayerPanel() {
            const panel = document.getElementById('mini-player-panel');
            if (!panel) return;
            const p = miniPlayerPrefs || { lyrics: true, style: 'glass', showWhen: 'hidden', corner: 'bottom-right' };

            const seg = (key, current, options) => options.map(o =>
                `<button type="button" class="fsl-seg-btn${current === o.value ? ' is-on' : ''} no-drag"` +
                ` onclick="setMiniPlayerPref(${jsAttr(key)},${jsAttr(o.value)})">` +
                (o.icon ? `<i class="fas ${o.icon}"></i>` : '') + `<span>${o.label}</span></button>`
            ).join('');
            const row = (label, controls) =>
                `<div class="fsl-cfg-row"><span class="fsl-cfg-label">${label}</span><div class="fsl-seg">${controls}</div></div>`;

            const connected = typeof spotifyConnectionState === 'undefined' || spotifyConnectionState === 'connected';
            panel.innerHTML =
                `<div class="fsl-cfg">` +
                    (connected ? '' :
                        `<div class="fsl-cfg-note"><i class="fas fa-triangle-exclamation"></i>` +
                        `<span>Connect <b>Spotify</b> first (Settings ▸ Spotify). The corner player shows whatever Spotify is playing.</span></div>`) +
                    row('Lyric line', seg('lyrics', p.lyrics ? 'on' : 'off', [
                        { value: 'on', icon: 'fa-closed-captioning', label: 'Show' },
                        { value: 'off', icon: 'fa-eye-slash', label: 'Hide' }
                    ])) +
                    row('Style', seg('style', p.style, [
                        { value: 'glass', icon: 'fa-circle-half-stroke', label: 'Glass' },
                        { value: 'white', icon: 'fa-sun', label: 'White' }
                    ])) +
                    row('Show', seg('showWhen', p.showWhen, [
                        { value: 'hidden', label: 'While Main is hidden' },
                        { value: 'always', label: 'Always' }
                    ])) +
                    `<div class="fsl-cfg-row"><span class="fsl-cfg-label">Corner</span>` +
                        `<div class="fsl-seg" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));">` +
                            seg('corner', p.corner, [
                                { value: 'top-left', label: 'Top left' },
                                { value: 'top-right', label: 'Top right' },
                                { value: 'bottom-left', label: 'Bottom left' },
                                { value: 'bottom-right', label: 'Bottom right' }
                            ]) +
                        `</div>` +
                    `</div>` +
                    `<p class="fsl-cfg-hint">` +
                        (p.showWhen === 'hidden' ? 'Hide or minimise Main to see it. ' : '') +
                        `Drag it to any corner, or right-click it for every option. It stays out of the way while nothing is playing.` +
                    `</p>` +
                `</div>`;
        }

        // ── Messages from main ──────────────────────────────────────────────────
        window.electronAPI?.onMiniPlayerChanged?.((p) => {
            if (p && typeof p === 'object') {
                miniPlayerPrefs = p;
                renderMiniPlayerPanel();
            }
        });
        // The corner player's expand button: main has already brought Main forward.
        window.electronAPI?.onMiniPlayerOpenFullscreen?.(() => {
            if (typeof openFullscreenLyrics === 'function') openFullscreenLyrics();
        });
        // "Turn off the corner player" from its own menu: flip the widget's switch.
        window.electronAPI?.onMiniPlayerTurnedOff?.(() => {
            if (typeof setMiniWidgetEnabled === 'function') setMiniWidgetEnabled('miniPlayer', false);
        });

        window.electronAPI?.miniPlayerGet?.().then((p) => {
            if (p && typeof p === 'object' && 'enabled' in p) miniPlayerPrefs = p;
            renderMiniPlayerPanel();
        }).catch(() => {});
        // The accent may already be applied by the time this script loads.
        setTimeout(pushMiniPlayerSync, 0);
