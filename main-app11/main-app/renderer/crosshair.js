        // ── Crosshair mini widget UI ──
        // Renders inside the #crosshair-panel container that renderMiniWidgetsSettings()
        // creates for the Crosshair registry entry. The actual on-screen crosshair is a
        // separate transparent overlay window owned by main/crosshair.js; this panel
        // edits the config, shows a live preview (same shared draw code the overlay
        // uses — renderer/crosshair-draw.js), and pushes every change over IPC.

        const CROSSHAIR_STYLES = [
            { v: 'cross', l: 'Cross' },
            { v: 'tshape', l: 'T' },
            { v: 'xshape', l: 'X' },
            { v: 'circle', l: 'Circle' },
            { v: 'dot', l: 'Dot' }
        ];
        const CROSSHAIR_COLOR_PRESETS = ['#00ff7f', '#ff3355', '#00d4ff', '#ff00ff', '#ffe600', '#ffffff'];

        function getCrosshairConfig() {
            return Object.assign({}, CROSSHAIR_DEFAULTS, safeParseJSON(localStorage.getItem('crosshairConfig'), {}));
        }

        function isCrosshairVisible() {
            return localStorage.getItem('crosshairVisible') !== 'false';
        }

        function isCrosshairWidgetEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.crosshair;
        }

        // Single source of truth push: main applies { enabled, visible, config }
        // idempotently, so this is safe to call on startup and on every edit.
        function pushCrosshairState() {
            if (!window.electronAPI?.crosshairApply) return;
            window.electronAPI.crosshairApply({
                enabled: isCrosshairWidgetEnabled(),
                visible: isCrosshairVisible(),
                config: getCrosshairConfig()
            });
        }

        // Called from applyMiniWidgetPrefs() when the widget toggle changes (and on
        // startup) — mirrors how the mic-mute overlay is enabled/disabled.
        function applyCrosshairEnabled() {
            pushCrosshairState();
            renderCrosshairPanel();
        }

        // The global hotkey flips visibility in the main process (it must work while
        // a game has focus); persist and mirror the new state here.
        if (window.electronAPI?.onCrosshairVisibilityChanged) {
            window.electronAPI.onCrosshairVisibilityChanged((visible) => {
                localStorage.setItem('crosshairVisible', visible ? 'true' : 'false');
                const btn = document.getElementById('crosshair-visible-toggle');
                if (btn) btn.checked = !!visible;
                showToast(visible ? 'Crosshair shown' : 'Crosshair hidden');
            });
        }

        function chSetVisible(visible) {
            localStorage.setItem('crosshairVisible', visible ? 'true' : 'false');
            pushCrosshairState();
        }

        // Discrete option changed (style button, color, toggle) — save, push, and
        // re-render so the active states repaint.
        function chSetOption(key, value) {
            const cfg = getCrosshairConfig();
            cfg[key] = value;
            localStorage.setItem('crosshairConfig', JSON.stringify(cfg));
            pushCrosshairState();
            renderCrosshairPanel();
        }

        // Custom color being dragged in the native picker — update live without
        // re-rendering (a re-render would replace the input mid-interaction); the
        // input's onchange fires chSetOption when the picker closes, which then
        // repaints the preset swatches' active state.
        function chSetColorLive(value) {
            const cfg = getCrosshairConfig();
            cfg.color = value;
            localStorage.setItem('crosshairConfig', JSON.stringify(cfg));
            paintCrosshairPreview();
            pushCrosshairState();
        }

        // Slider moved — update in place (no re-render, so the drag isn't broken),
        // repaint the preview, and push live to the overlay.
        function chSetSlider(key, value, suffix) {
            const cfg = getCrosshairConfig();
            const num = Number(value);
            cfg[key] = key === 'opacity' ? Math.max(0.1, Math.min(1, num / 100)) : num;
            localStorage.setItem('crosshairConfig', JSON.stringify(cfg));
            const label = document.getElementById(`crosshair-val-${key}`);
            if (label) label.textContent = `${value}${suffix || ''}`;
            paintCrosshairPreview();
            pushCrosshairState();
        }

        function chResetConfig() {
            localStorage.setItem('crosshairConfig', JSON.stringify(CROSSHAIR_DEFAULTS));
            pushCrosshairState();
            renderCrosshairPanel();
            showToast('Crosshair reset to defaults');
        }

        function paintCrosshairPreview() {
            const canvas = document.getElementById('crosshair-preview');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth || 240;
            const h = canvas.clientHeight || 130;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawCrosshair(ctx, w, h, getCrosshairConfig());
        }

        function crosshairSliderRow(label, key, min, max, value, suffix) {
            return `<div class="flex items-center gap-3">
                <span class="text-[11px] text-neutral-400 w-16 shrink-0">${label}</span>
                <input type="range" min="${min}" max="${max}" value="${value}" class="ve-vol-slider flex-1 no-drag"
                    oninput="chSetSlider('${key}', this.value, '${suffix || ''}')">
                <span class="ve-vol-val" id="crosshair-val-${key}">${value}${suffix || ''}</span>
            </div>`;
        }

        function renderCrosshairPanel() {
            const panel = document.getElementById('crosshair-panel');
            if (!panel) return;
            if (!isCrosshairWidgetEnabled()) { panel.innerHTML = ''; return; }

            const cfg = getCrosshairConfig();
            const visible = isCrosshairVisible();
            const hotkeyLabel = formatHotkeyDisplay(hotkeys.crosshair || DEFAULT_HOTKEYS.crosshair);

            panel.innerHTML = `<div class="mt-3 space-y-3">
                <!-- Live preview on a game-like dark backdrop -->
                <div class="rounded-xl border border-white/10 overflow-hidden" style="background:
                    radial-gradient(circle at 30% 40%, #1d232e 0%, #12151b 65%, #0b0d11 100%)">
                    <canvas id="crosshair-preview" class="w-full block" style="height:130px"></canvas>
                </div>

                <div class="flex items-center justify-between gap-3">
                    <label class="flex items-center gap-3 cursor-pointer text-xs">
                        <span class="ios-toggle"><input type="checkbox" id="crosshair-visible-toggle" class="ios-toggle-input" ${visible ? 'checked' : ''} onchange="chSetVisible(this.checked)"><span class="ios-toggle-track"></span></span>
                        <span>Show crosshair</span>
                    </label>
                    <span class="text-[10px] text-neutral-600">Toggle anywhere: <kbd class="text-neutral-500">${esc(hotkeyLabel)}</kbd></span>
                </div>

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Style</p>
                    <div class="grid grid-cols-5 gap-1.5">${CROSSHAIR_STYLES.map((s) => `
                        <button type="button" onclick="chSetOption('style', '${s.v}')"
                            class="px-1.5 py-1.5 rounded-lg text-[11px] border transition-colors no-drag ${cfg.style === s.v
                                ? 'bg-white/15 border-white/25 text-white'
                                : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">${s.l}</button>`).join('')}
                    </div>
                </div>

                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Color</p>
                    <div class="flex items-center gap-1.5">
                        ${CROSSHAIR_COLOR_PRESETS.map((col) => `
                        <button type="button" onclick="chSetOption('color', '${col}')" title="${col}"
                            class="w-7 h-7 rounded-lg border transition-transform no-drag hover:scale-110 ${cfg.color.toLowerCase() === col ? 'border-white' : 'border-white/15'}"
                            style="background:${col}"></button>`).join('')}
                        <input type="color" value="${esc(cfg.color)}" title="Custom color"
                            class="w-7 h-7 rounded-lg bg-transparent border border-white/15 cursor-pointer no-drag"
                            oninput="chSetColorLive(this.value)" onchange="chSetOption('color', this.value)">
                    </div>
                </div>

                <div class="space-y-2">
                    ${crosshairSliderRow('Size', 'size', 2, 60, cfg.size, 'px')}
                    ${crosshairSliderRow('Gap', 'gap', 0, 30, cfg.gap, 'px')}
                    ${crosshairSliderRow('Thickness', 'thickness', 1, 10, cfg.thickness, 'px')}
                    ${crosshairSliderRow('Opacity', 'opacity', 10, 100, Math.round(cfg.opacity * 100), '%')}
                    ${cfg.dot && cfg.style !== 'dot' ? crosshairSliderRow('Dot size', 'dotSize', 1, 10, cfg.dotSize, 'px') : ''}
                </div>

                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-5">
                        <label class="flex items-center gap-2.5 cursor-pointer text-xs ${cfg.style === 'dot' ? 'opacity-40' : ''}">
                            <span class="ios-toggle"><input type="checkbox" class="ios-toggle-input" ${cfg.dot ? 'checked' : ''} ${cfg.style === 'dot' ? 'disabled' : ''} onchange="chSetOption('dot', this.checked)"><span class="ios-toggle-track"></span></span>
                            <span>Center dot</span>
                        </label>
                        <label class="flex items-center gap-2.5 cursor-pointer text-xs">
                            <span class="ios-toggle"><input type="checkbox" class="ios-toggle-input" ${cfg.outline ? 'checked' : ''} onchange="chSetOption('outline', this.checked)"><span class="ios-toggle-track"></span></span>
                            <span>Outline</span>
                        </label>
                    </div>
                    <button type="button" onclick="chResetConfig()" class="hotkey-bind no-drag">Reset</button>
                </div>

                <p class="text-[10px] text-neutral-600 leading-relaxed">Shows over windowed and borderless games. True exclusive-fullscreen games draw over every overlay app — switch the game to borderless if the crosshair isn't visible.</p>
            </div>`;

            paintCrosshairPreview();
        }
