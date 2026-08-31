        // ── Auto Clicker mini widget UI ──
        // Renders inside the #autoclicker-panel container the Widget Library
        // creates for the Auto Clicker registry entry. All state lives in the main
        // process (autoclicker-config.json) because the click engine, the trigger
        // hotkey and the on-screen picker are main-process concerns — this file is
        // the control surface for them.
        //
        // Render strategy: the panel is rebuilt from innerHTML whenever the config
        // changes, but live run updates (click counter, elapsed, colour-hunt state)
        // arrive several times a second, so those patch individual nodes instead —
        // re-rendering at that rate would fight the animations and kill input focus.

        let acData = null;              // last snapshot from autoclicker-get
        let acBindActive = false;       // capturing the trigger hotkey
        let acScanResult = null;        // last "Test scan" result
        let acMapRaf = null;            // preview canvas animation frame
        let acMapState = null;          // ripples / sweep progress for the preview
        let acSuppressContextMenu = false;
        let acPicking = false;          // an on-screen picker is open
        let acLastMode = null;          // drives the mode-body slide-in

        const AC_MODES = [
            ['cursor', 'At cursor', 'fa-location-crosshairs'],
            ['point', 'Fixed point', 'fa-crosshairs'],
            ['area', 'Area spam', 'fa-vector-square'],
            ['color', 'Colour hunt', 'fa-eye-dropper']
        ];
        const AC_MODE_HINTS = {
            cursor: 'Clicks wherever your pointer happens to be — move the mouse and the clicks follow it.',
            point: 'Clicks one fixed spot on screen, no matter where your pointer is. Pick it with a magnified loupe.',
            area: 'Clicks all over a region you drag out on screen — scattered, or a sweep that covers every part of it.',
            color: 'Watches a region for a colour and clicks it the moment it shows up. Tune the tolerance so near-misses still count.'
        };
        const AC_PATTERNS = [
            ['random', 'Random', 'fa-shuffle'],
            ['sweep', 'Sweep', 'fa-grip-lines'],
            ['center', 'Centre', 'fa-bullseye']
        ];
        const AC_PATTERN_HINTS = {
            random: 'Every click lands on a random point inside the region.',
            sweep: 'Walks the region in a serpentine grid so every part of it gets clicked, then starts over.',
            center: 'Every click lands dead centre of the region.'
        };
        const AC_CLICK_TYPES = [['single', 'Single'], ['double', 'Double'], ['triple', 'Triple']];
        const AC_TARGETS = [
            ['first', 'First match'],
            ['center', 'Nearest centre'],
            ['centroid', 'Middle of all'],
            ['all', 'Every match']
        ];
        const AC_TARGET_HINTS = {
            first: 'Clicks the first matching pixel found, scanning top-left to bottom-right.',
            center: 'Clicks the match closest to the middle of the region.',
            centroid: 'Clicks the average position of every match — good for one big blob.',
            all: 'Clicks every separate blob of the colour in turn, one per interval.'
        };
        const AC_REPEATS = [['infinite', 'Until stopped'], ['count', 'Click count'], ['duration', 'For a time']];
        const AC_BUTTONS = ['Left click', 'Right click', 'Middle click', 'Mouse 4 (back)', 'Mouse 5 (forward)'];
        const AC_BUTTON_HINTS = [
            'The everyday click — what almost every auto clicker job needs.',
            'Opens context menus, and is the attack/aim button in a lot of games.',
            'The scroll wheel press.',
            'The rear thumb button on the side of the mouse.',
            'The forward thumb button on the side of the mouse.'
        ];
        const AC_INTERVAL_PRESETS = [
            [1000, '1 / sec'], [200, '5 / sec'], [100, '10 / sec'],
            [50, '20 / sec'], [20, '50 / sec'], [10, '100 / sec']
        ];
        // Mouse buttons usable as a trigger (kept in sync with MOUSE_HOTKEY_BUTTON
        // in main/autoClicker.js). DOM MouseEvent.button → hotkey name.
        const AC_MOUSE_HOTKEYS = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'Mouse4', 4: 'Mouse5' };
        const AC_MOUSE_LABELS = { MouseLeft: 'Left Click', MouseRight: 'Right Click', MouseMiddle: 'Middle Click', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5' };
        // Hotkey name → the click-button index it would collide with.
        const AC_HOTKEY_BUTTON = { MouseLeft: 0, MouseRight: 1, MouseMiddle: 2, Mouse4: 3, Mouse5: 4 };

        function acFormatHotkey(hk) {
            if (hk && AC_MOUSE_LABELS[hk]) return AC_MOUSE_LABELS[hk];
            return formatHotkeyDisplay(hk);
        }

        function acAccent() {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            return v || '255, 255, 255';
        }

        // Rough cost of one click cycle, mirroring the engine's own timing, so the
        // "clicks per second" readout is honest rather than just 1000/interval.
        function acCycleMs(c) {
            const per = c.clickType === 'triple' ? 3 : (c.clickType === 'double' ? 2 : 1);
            const clickCost = per * c.pressMs + (per - 1) * 55;
            const move = c.mode === 'cursor' ? 0 : 6;
            return Math.max(1, c.interval + clickCost + move);
        }

        function acRate(c) {
            return 1000 / acCycleMs(c);
        }

        function acFormatRate(r) {
            if (r >= 10) return r.toFixed(1);
            if (r >= 1) return r.toFixed(2);
            return r.toFixed(3);
        }

        function acMsParts(ms) {
            const total = Math.max(0, Math.round(ms));
            return {
                h: Math.floor(total / 3600000),
                m: Math.floor(total / 60000) % 60,
                s: Math.floor(total / 1000) % 60,
                ms: total % 1000
            };
        }

        function acFormatDuration(ms) {
            const p = acMsParts(ms);
            if (p.h) return `${p.h}h ${p.m}m`;
            if (p.m) return `${p.m}m ${p.s}s`;
            if (p.s) return p.ms ? `${p.s}.${String(Math.floor(p.ms / 100))}s` : `${p.s}s`;
            return `${p.ms}ms`;
        }

        // Mirrors coversArea() in main/autoClicker.js — the run is refused there
        // too; this is so the panel can say why before the user hits Start.
        function acExclusionCoversArea(c) {
            const a = c && c.area, e = c && c.exclude;
            if (!a || !e) return false;
            return e.x <= a.x && e.y <= a.y && e.x + e.w >= a.x + a.w && e.y + e.h >= a.y + a.h;
        }

        function acCentreExcluded(c) {
            const a = c && c.area, e = c && c.exclude;
            if (!a || !e) return false;
            const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
            return cx >= e.x && cx < e.x + e.w && cy >= e.y && cy < e.y + e.h;
        }

        function acHotkeyConflict(c) {
            return c && AC_HOTKEY_BUTTON[c.hotkey] !== undefined && AC_HOTKEY_BUTTON[c.hotkey] === c.button;
        }

        // What's stopping Start from working right now, phrased for the user.
        function acBlocker(c) {
            if (!c) return null;
            if (c.mode === 'point' && !c.point) return 'Pick the point to click first.';
            if ((c.mode === 'area' || c.mode === 'color') && !c.area) return 'Select the region on screen first.';
            if (c.mode === 'area' && acExclusionCoversArea(c)) return 'The exclusion zone covers the whole region — nothing is left to click.';
            if (c.mode === 'area' && c.pattern === 'center' && acCentreExcluded(c)) return 'The exclusion zone covers the centre point, so Centre has nothing to click.';
            if (acHotkeyConflict(c)) return `The trigger is ${AC_MOUSE_LABELS[c.hotkey]} — the same button it would be clicking. Pick a different trigger or a different button.`;
            return null;
        }

        async function acRefresh() {
            if (!window.electronAPI?.autoClickerGet) return;
            try {
                acData = await window.electronAPI.autoClickerGet();
            } catch (e) {
                console.error('Failed to load auto clicker state', e);
            }
        }

        // ── Render ──
        // Every write rebuilds the panel, so the entrance choreography has to be
        // gated: it should play when the widget's detail view opens, not every
        // time a slider is nudged. The Widget Library recreates the panel div
        // each time the detail opens, so a marker on that div is exactly the
        // "is this a fresh mount" signal we want.
        function acShouldAnimate(panel) {
            if (panel.dataset.acMounted === '1') return false;
            panel.dataset.acMounted = '1';
            return true;
        }

        async function renderAutoClickerPanel() {
            const panel = document.getElementById('autoclicker-panel');
            if (!panel) return;
            await acRefresh();
            if (!acData) { panel.innerHTML = ''; return; }
            const animate = acShouldAnimate(panel);
            panel.innerHTML = acPanelHtml(acData, animate);
            acAfterRender();
        }

        // Rebuilds from the in-memory snapshot without a round trip — used after a
        // patch has already returned the fresh config.
        function acRerender() {
            const panel = document.getElementById('autoclicker-panel');
            if (!panel || !acData) return;
            panel.innerHTML = acPanelHtml(acData, acShouldAnimate(panel));
            acAfterRender();
        }

        function acPanelHtml(c, animate) {
            const blocker = acBlocker(c);
            // The mode body still slides in when the mode actually changes — that
            // transition is the point of it — but not on unrelated edits.
            const modeChanged = acLastMode !== c.mode;
            acLastMode = c.mode;
            return `<div class="ac-root${animate ? '' : ' ac-no-anim'}${modeChanged ? ' ac-mode-changed' : ''}">
                ${acHeroHtml(c, blocker)}
                ${acWhereHtml(c)}
                ${acHowHtml(c)}
                ${acTimingHtml(c)}
                ${acLimitsHtml(c)}
                ${acTriggerHtml(c)}
            </div>`;
        }

        function acHeroHtml(c, blocker) {
            const running = !!c.running;
            const stats = c.stats || { clicks: 0, elapsed: 0 };
            const liveRate = running && stats.elapsed > 250 ? (stats.clicks / (stats.elapsed / 1000)) : acRate(c);
            const modeLabel = (AC_MODES.find(m => m[0] === c.mode) || AC_MODES[0])[1];
            const sub = running
                ? `<b>${esc(AC_BUTTONS[c.button])}</b> · ${esc(modeLabel.toLowerCase())} · press <b>${esc(acFormatHotkey(c.hotkey))}</b> to stop`
                : (blocker
                    ? esc(blocker)
                    : `<b>${esc(AC_BUTTONS[c.button])}</b> · ${esc(modeLabel.toLowerCase())} · about <b>${acFormatRate(acRate(c))}</b> per second`);
            return `<div class="ac-hero" id="ac-hero" data-state="${running ? 'running' : 'idle'}">
                <div class="ac-orb">
                    <span class="ac-orb-ring"></span><span class="ac-orb-ring b"></span>
                    <i class="fas fa-arrow-pointer"></i>
                </div>
                <div class="ac-hero-text">
                    <div class="ac-hero-title" id="ac-hero-title">${running ? 'Clicking' : (c.armed ? 'Ready' : 'Trigger off')}</div>
                    <div class="ac-hero-sub" id="ac-hero-sub">${sub}</div>
                </div>
                <div class="ac-hero-stats">
                    <div class="ac-stat" id="ac-stat-clicks"><b>${stats.clicks || 0}</b><span>clicks</span></div>
                    <div class="ac-stat" id="ac-stat-rate"><b>${acFormatRate(liveRate)}</b><span>per sec</span></div>
                    <div class="ac-stat" id="ac-stat-time"><b>${acFormatDuration(stats.elapsed || 0)}</b><span>elapsed</span></div>
                </div>
                <button type="button" class="ac-go ${running ? 'stop' : ''}" id="ac-go" onclick="acToggleRun()"
                    ${!running && blocker ? 'disabled' : ''} title="${esc(blocker || '')}">
                    <i class="fas ${running ? 'fa-stop' : 'fa-play'}"></i>${running ? 'Stop' : 'Start'}
                </button>
            </div>`;
        }

        function acSegHtml(id, options, current, handler) {
            const buttons = options.map(([value, label, icon]) => `
                <button type="button" class="ac-seg-btn ${current === value ? 'on' : ''}" onclick="${handler}(${jsAttr(value)})">
                    ${icon ? `<i class="fas ${icon}"></i>` : ''}<span>${esc(label)}</span>
                </button>`).join('');
            // The pill can only be positioned after layout, and it's a brand new
            // element on every re-render — so it starts with transitions off and
            // gets them back a frame later (see acPositionPill). Without that it
            // would visibly grow from zero width each time the panel rebuilds.
            return `<div class="ac-seg" id="${id}" style="grid-template-columns: repeat(${options.length}, minmax(0, 1fr));">
                <div class="ac-seg-pill is-init"></div>${buttons}
            </div>`;
        }

        function acWhereHtml(c) {
            let body = `<p class="ac-note">${esc(AC_MODE_HINTS[c.mode])}</p>`;

            if (c.mode === 'point') {
                body += `<div class="ac-target-row" style="margin-top:12px;">
                    ${c.point
                        ? `<span class="ac-chip"><span class="ac-chip-k">point</span>${c.point.x}, ${c.point.y}</span>`
                        : `<span class="ac-chip empty"><span class="ac-chip-k">point</span>not set</span>`}
                    <button type="button" class="ac-pick" onclick="acPick('point')" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-crosshairs"></i>${c.point ? 'Pick again' : 'Pick point on screen'}
                    </button>
                </div>`;
            } else if (c.mode === 'area' || c.mode === 'color') {
                body += `<div class="ac-target-row" style="margin-top:12px;">
                    ${c.area
                        ? `<span class="ac-chip"><span class="ac-chip-k">region</span>${c.area.w} × ${c.area.h}<span class="ac-chip-k">at</span>${c.area.x}, ${c.area.y}</span>`
                        : `<span class="ac-chip empty"><span class="ac-chip-k">region</span>not set</span>`}
                    <button type="button" class="ac-pick" onclick="acPick('area')" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-vector-square"></i>${c.area ? 'Re-select area' : 'Select area on screen'}
                    </button>
                </div>`;
            }

            if (c.mode === 'area') {
                body += `<div style="margin-top:12px;">
                    ${acSegHtml('ac-seg-pattern', AC_PATTERNS, c.pattern, 'acSetPattern')}
                    <p class="ac-note" style="margin-top:8px;">${esc(AC_PATTERN_HINTS[c.pattern])}</p>
                </div>`;
                body += acExclusionHtml(c);
                if (c.pattern === 'sweep') {
                    body += `<div class="ac-grid" style="grid-template-columns: 1fr 1fr; margin-top:12px;">
                        <div class="ac-field">
                            <div class="ac-slider-head"><label>Column spacing</label><b>${c.spacingX} px</b></div>
                            <input type="range" class="ac-slider" min="4" max="200" value="${c.spacingX}"
                                oninput="acSliderLive(this, 'px')" onchange="acPatch({ spacingX: +this.value })">
                        </div>
                        <div class="ac-field">
                            <div class="ac-slider-head"><label>Row spacing</label><b>${c.spacingY} px</b></div>
                            <input type="range" class="ac-slider" min="4" max="200" value="${c.spacingY}"
                                oninput="acSliderLive(this, 'px')" onchange="acPatch({ spacingY: +this.value })">
                        </div>
                    </div>`;
                }
            }

            if (c.mode === 'color') body += acColorHtml(c);

            // The live preview only makes sense once there's a region to preview.
            if ((c.mode === 'area' || c.mode === 'color') && c.area) {
                body += `<div class="ac-map-wrap"><canvas id="ac-map"></canvas>
                    <span class="ac-map-label">${c.mode === 'color' ? 'detection preview' : 'click pattern'}</span></div>`;
            } else if ((c.mode === 'area' || c.mode === 'color') && !c.area) {
                body += `<div class="ac-empty">
                    <i class="fas fa-vector-square"></i>
                    <p>Pick the part of the screen to work on. The launcher steps out of the way, the screen freezes, and you drag a box over the region.</p>
                    <button type="button" class="ac-pick" onclick="acPick('area')" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-crop-simple"></i>Select area on screen</button>
                </div>`;
            }

            if (c.mode !== 'cursor') {
                body += `<div style="margin-top:12px; display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
                    <label class="ac-check" title="Puts the pointer back where it was after every click">
                        <input type="checkbox" ${c.restore ? 'checked' : ''} onchange="acPatch({ restore: this.checked })">
                        Return the pointer afterwards
                    </label>
                    <div class="ac-field" style="min-width:170px; flex:1 1 170px;">
                        <div class="ac-slider-head"><label>Aim scatter</label><b>${c.spread ? `± ${c.spread} px` : 'exact'}</b></div>
                        <input type="range" class="ac-slider" min="0" max="80" value="${c.spread}"
                            oninput="acSliderLive(this, 'px', 'exact')" onchange="acPatch({ spread: +this.value })">
                    </div>
                </div>`;
            }

            return `<div class="ac-card" style="--i:1;">
                <div class="ac-card-head">
                    <span class="ac-head-icon"><i class="fas fa-location-dot"></i></span>
                    <h4>Where it clicks</h4>
                </div>
                ${acSegHtml('ac-seg-mode', AC_MODES, c.mode, 'acSetMode')}
                <div class="ac-mode-body" id="ac-mode-body">${body}</div>
            </div>`;
        }

        // Opt-in "don't click here" sub-region. Kept to Area spam: in Colour Hunt
        // a keep-out zone would fight the colour matching, so it isn't offered.
        function acExclusionHtml(c) {
            if (!c.area) return '';
            const covers = acExclusionCoversArea(c);
            return `<div style="margin-top:14px;">
                <div class="ac-target-row">
                    ${c.exclude
                        ? `<span class="ac-chip ac-chip-danger"><span class="ac-chip-k">skip</span>${c.exclude.w} × ${c.exclude.h}<span class="ac-chip-k">at</span>${c.exclude.x}, ${c.exclude.y}</span>`
                        : `<span class="ac-chip empty"><span class="ac-chip-k">skip zone</span>none</span>`}
                    <button type="button" class="ac-pick ghost" onclick="acPick('exclude')" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-ban"></i>${c.exclude ? 'Redraw skip zone' : 'Add a skip zone'}
                    </button>
                    ${c.exclude
                        ? `<button type="button" class="ac-pick ghost" onclick="acClearExclusion()" title="Remove the skip zone"><i class="fas fa-xmark"></i>Clear</button>`
                        : ''}
                </div>
                <p class="ac-note" style="margin-top:8px;">${c.exclude
                    ? 'Clicks never land inside the skip zone — useful for leaving a button, a close box or a menu alone in the middle of the region.'
                    : 'Optional: mark a part of the region that should never be clicked.'}</p>
                ${covers ? `<div class="ac-warn"><i class="fas fa-triangle-exclamation" style="margin-top:2px;"></i>
                    <span>The skip zone covers the whole region, so there is nowhere left to click. Make it smaller, or clear it.</span></div>` : ''}
            </div>`;
        }

        function acColorHtml(c) {
            const rgb = acHexToRgb(c.color);
            const lo = acShiftHex(rgb, -c.tolerance);
            const hi = acShiftHex(rgb, c.tolerance);
            const scanLabel = c.scanStep === 1 ? 'every pixel' : `every ${c.scanStep}${c.scanStep === 2 ? 'nd' : (c.scanStep === 3 ? 'rd' : 'th')} pixel`;
            const result = acScanResult
                ? (acScanResult.pending
                    ? `<span class="ac-scan-result miss"><i class="fas fa-circle-notch fa-spin"></i>Scanning the region…</span>`
                    : acScanResult.ok
                    ? (acScanResult.matches
                        ? `<span class="ac-scan-result hit"><i class="fas fa-circle-check"></i>Found ${acScanResult.matches.toLocaleString()} matching spot${acScanResult.matches === 1 ? '' : 's'} right now</span>`
                        : `<span class="ac-scan-result miss"><i class="fas fa-circle-question"></i>Nothing matched — widen the tolerance, or scan every pixel</span>`)
                    : `<span class="ac-scan-result miss"><i class="fas fa-triangle-exclamation"></i>${esc(acScanErrorText(acScanResult.error))}</span>`)
                : '';

            const second = c.color2
                ? `<div class="ac-color-row" style="margin-top:10px;">
                        <button type="button" class="ac-swatch" style="background:${esc(c.color2)};"
                            onclick="acPick('color2')" title="Pick the second colour from the screen" ${acPicking ? 'disabled' : ''}>
                            <i class="fas fa-eye-dropper"></i>
                        </button>
                        <div style="flex:1 1 150px; min-width:0;">
                            <div class="ac-field">
                                <label>Second colour</label>
                                <input type="text" class="ac-input" value="${esc(c.color2)}" spellcheck="false"
                                    onchange="acSetColor2(this.value)" style="text-transform:uppercase;">
                            </div>
                        </div>
                        <button type="button" class="ac-pick ghost" onclick="acClearColor2()" title="Hunt one colour only">
                            <i class="fas fa-xmark"></i>Remove
                        </button>
                    </div>`
                : `<button type="button" class="ac-pick ghost" style="margin-top:10px;"
                        onclick="acPick('color2')" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-plus"></i>Add a second colour
                    </button>`;

            return `<div style="margin-top:14px;">
                <div class="ac-color-row">
                    <button type="button" class="ac-swatch" style="background:${esc(c.color)};"
                        onclick="acPick('color')" title="Pick a colour from the screen" ${acPicking ? 'disabled' : ''}>
                        <i class="fas fa-eye-dropper"></i>
                    </button>
                    <div style="flex:1 1 150px; min-width:0;">
                        <div class="ac-field">
                            <label>${c.color2 ? 'First colour' : 'Target colour'}</label>
                            <input type="text" class="ac-input" value="${esc(c.color)}" spellcheck="false"
                                onchange="acSetColor(this.value)" style="text-transform:uppercase;">
                        </div>
                    </div>
                    <button type="button" class="ac-pick ghost" onclick="acTestScan()" ${c.area ? '' : 'disabled'}>
                        <i class="fas fa-magnifying-glass"></i>Test scan
                    </button>
                </div>
                ${second}
                ${c.color2 ? `<p class="ac-note" style="margin-top:8px;">Either colour counts as a match — whichever shows up first gets clicked.</p>` : ''}
                ${result ? `<div style="margin-top:10px;">${result}</div>` : ''}

                <div class="ac-field" style="margin-top:14px;">
                    <div class="ac-slider-head"><label>Tolerance</label><b>± ${c.tolerance}</b></div>
                    <input type="range" class="ac-slider" min="0" max="120" value="${c.tolerance}"
                        oninput="acSliderLive(this, '', '', '± ')" onchange="acPatch({ tolerance: +this.value })">
                    <div class="ac-tol-band" style="background: linear-gradient(90deg, ${lo}, ${esc(c.color)} 50%, ${hi});"></div>
                    ${c.color2 ? (() => {
                        const g2 = acHexToRgb(c.color2);
                        return `<div class="ac-tol-band" style="margin-top:5px; background: linear-gradient(90deg, ${acShiftHex(g2, -c.tolerance)}, ${esc(c.color2)} 50%, ${acShiftHex(g2, c.tolerance)});"></div>`;
                    })() : ''}
                    <p class="ac-note" style="margin-top:6px;">Anything between these shades counts as a match${c.color2 ? ' — the same tolerance applies to both colours.' : '.'}</p>
                </div>

                <div class="ac-grid" style="grid-template-columns: 1fr 1fr; margin-top:14px;">
                    <div class="ac-field">
                        <div class="ac-slider-head"><label>Scan precision</label><b>${esc(scanLabel)}</b></div>
                        <input type="range" class="ac-slider" min="1" max="8" value="${c.scanStep}"
                            oninput="acSliderLive(this, 'px step')" onchange="acPatch({ scanStep: +this.value })">
                        <p class="ac-note" style="margin-top:6px;">Checking every pixel is the most reliable; skipping some is much lighter on a big region.</p>
                    </div>
                    <div class="ac-field">
                        <div class="ac-slider-head"><label>Re-check when missing</label><b>${c.rescanMs} ms</b></div>
                        <input type="range" class="ac-slider" min="10" max="2000" step="10" value="${c.rescanMs}"
                            oninput="acSliderLive(this, 'ms')" onchange="acPatch({ rescanMs: +this.value })">
                    </div>
                </div>

                <div class="ac-field" style="margin-top:14px;">
                    <label>What to click when it matches</label>
                    ${acSegHtml('ac-seg-target', AC_TARGETS, c.targetMode, 'acSetTarget')}
                    <p class="ac-note" style="margin-top:8px;">${esc(AC_TARGET_HINTS[c.targetMode])}</p>
                </div>
                ${c.targetMode === 'all' ? `<div class="ac-field" style="margin-top:12px;">
                    <div class="ac-slider-head"><label>Keep matches at least</label><b>${c.minDist} px apart</b></div>
                    <input type="range" class="ac-slider" min="4" max="200" value="${c.minDist}"
                        oninput="acSliderLive(this, 'px apart')" onchange="acPatch({ minDist: +this.value })">
                </div>` : ''}
            </div>`;
        }

        function acScanErrorText(error) {
            if (error === 'no-area') return 'Select a region first';
            if (error === 'area-too-large') return 'That region is too large to scan';
            if (error === 'timeout') return 'The scan timed out';
            return 'The scan could not run';
        }

        function acHowHtml(c) {
            return `<div class="ac-card" style="--i:2;">
                <div class="ac-card-head">
                    <span class="ac-head-icon"><i class="fas fa-computer-mouse"></i></span>
                    <h4>How it clicks</h4>
                </div>
                <div class="ac-mouse-row">
                    ${acMouseSvg(c.button)}
                    <div class="ac-mouse-legend">
                        <div class="name">${esc(AC_BUTTONS[c.button])}</div>
                        <div class="hint">${esc(AC_BUTTON_HINTS[c.button])}</div>
                    </div>
                </div>
                <div class="ac-grid" style="grid-template-columns: 1fr 1fr; margin-top:14px;">
                    <div class="ac-field">
                        <label>Click type</label>
                        ${acSegHtml('ac-seg-clicktype', AC_CLICK_TYPES, c.clickType, 'acSetClickType')}
                    </div>
                    <div class="ac-field">
                        <div class="ac-slider-head"><label>Press duration</label><b>${c.pressMs} ms</b></div>
                        <input type="range" class="ac-slider" min="1" max="250" value="${c.pressMs}"
                            oninput="acSliderLive(this, 'ms')" onchange="acPatch({ pressMs: +this.value })">
                        <p class="ac-note" style="margin-top:6px;">How long each press is held down. Some games ignore presses shorter than a frame.</p>
                    </div>
                </div>
            </div>`;
        }

        // Clickable mouse diagram — the button picker. Zones are real SVG shapes so
        // choosing "Mouse 4" is a matter of clicking the thumb button, not reading
        // a dropdown.
        function acMouseSvg(button) {
            const zone = (b, shape) => shape.replace('__CLS__', `zone${button === b ? ' on' : ''}`).replace('__B__', String(b));
            return `<svg class="ac-mouse" viewBox="0 0 92 148" role="group" aria-label="Mouse button">
                <defs>
                    <clipPath id="ac-mouse-clip"><rect x="14" y="4" width="64" height="140" rx="32" ry="40"/></clipPath>
                </defs>
                <g clip-path="url(#ac-mouse-clip)">
                    ${zone(0, '<rect class="__CLS__" data-b="__B__" x="14" y="4" width="32" height="62" onclick="acSetButton(0)"/>')}
                    ${zone(1, '<rect class="__CLS__" data-b="__B__" x="46" y="4" width="32" height="62" onclick="acSetButton(1)"/>')}
                </g>
                ${zone(2, '<rect class="__CLS__" data-b="__B__" x="41" y="20" width="10" height="24" rx="5" onclick="acSetButton(2)"/>')}
                ${zone(3, '<rect class="__CLS__" data-b="__B__" x="2" y="52" width="12" height="17" rx="4" onclick="acSetButton(3)"/>')}
                ${zone(4, '<rect class="__CLS__" data-b="__B__" x="2" y="73" width="12" height="17" rx="4" onclick="acSetButton(4)"/>')}
                <rect class="shell" x="14" y="4" width="64" height="140" rx="32" ry="40"/>
                <line class="split" x1="46" y1="4" x2="46" y2="66"/>
                <line class="split" x1="14" y1="66" x2="78" y2="66"/>
            </svg>`;
        }

        function acTimingHtml(c) {
            const p = acMsParts(c.interval);
            const rate = acRate(c);
            // Log scale: 0.1/sec at the left, 200/sec at the right.
            const pct = Math.max(2, Math.min(100, ((Math.log10(Math.max(0.1, rate)) + 1) / 3.3) * 100));
            const cell = (key, value, unit, max) => `<div class="ac-time-cell">
                <input type="number" class="ac-input" min="0" ${max ? `max="${max}"` : ''} value="${value}"
                    data-ac-time="${key}" onchange="acSetInterval()">
                <span>${unit}</span></div>`;
            return `<div class="ac-card" style="--i:3;">
                <div class="ac-card-head">
                    <span class="ac-head-icon"><i class="fas fa-stopwatch"></i></span>
                    <h4>Timing</h4>
                    <span class="ac-head-note">gap between clicks</span>
                </div>
                <div class="ac-time-row">
                    ${cell('h', p.h, 'hr')}
                    ${cell('m', p.m, 'min', 59)}
                    ${cell('s', p.s, 'sec', 59)}
                    ${cell('ms', p.ms, 'ms', 999)}
                </div>
                <div class="ac-presets">
                    ${AC_INTERVAL_PRESETS.map(([ms, label]) =>
                        `<button type="button" class="ac-preset ${c.interval === ms ? 'on' : ''}" onclick="acPatch({ interval: ${ms} })">${esc(label)}</button>`).join('')}
                </div>
                <div class="ac-rate">
                    <b id="ac-rate-value">${acFormatRate(rate)}</b><span>clicks per second</span>
                </div>
                <div class="ac-rate-bar"><div class="ac-rate-fill" style="width:${pct.toFixed(1)}%"></div></div>
                <div class="ac-field" style="margin-top:14px;">
                    <div class="ac-slider-head">
                        <label>Randomness</label><b>${c.jitter ? `± ${c.jitter} ms` : 'off — exact interval'}</b>
                    </div>
                    <input type="range" class="ac-slider" min="0" max="500" step="5" value="${c.jitter}"
                        oninput="acSliderLive(this, 'ms', 'off — exact interval', '± ')" onchange="acPatch({ jitter: +this.value })">
                    <p class="ac-note" style="margin-top:6px;">Varies each gap by up to this much so the rhythm isn't perfectly machine-even.</p>
                </div>
            </div>`;
        }

        function acLimitsHtml(c) {
            const d = acMsParts(c.durationMs);
            let extra = '';
            if (c.repeatMode === 'count') {
                extra = `<div class="ac-field" style="margin-top:12px; max-width:200px;">
                    <label>Stop after</label>
                    <input type="number" class="ac-input" min="1" value="${c.repeatCount}"
                        onchange="acPatch({ repeatCount: +this.value })">
                </div>`;
            } else if (c.repeatMode === 'duration') {
                extra = `<div class="ac-time-row" style="margin-top:12px;">
                    <div class="ac-time-cell"><input type="number" class="ac-input" min="0" value="${d.h}" data-ac-dur="h" onchange="acSetDuration()"><span>hr</span></div>
                    <div class="ac-time-cell"><input type="number" class="ac-input" min="0" max="59" value="${d.m}" data-ac-dur="m" onchange="acSetDuration()"><span>min</span></div>
                    <div class="ac-time-cell"><input type="number" class="ac-input" min="0" max="59" value="${d.s}" data-ac-dur="s" onchange="acSetDuration()"><span>sec</span></div>
                    <div class="ac-time-cell"><input type="number" class="ac-input" min="0" max="999" value="${d.ms}" data-ac-dur="ms" onchange="acSetDuration()"><span>ms</span></div>
                </div>`;
            }
            const projected = c.repeatMode === 'count'
                ? `About ${acFormatDuration(c.repeatCount * acCycleMs(c))} at this rate.`
                : (c.repeatMode === 'duration'
                    ? `About ${Math.round(c.durationMs / acCycleMs(c)).toLocaleString()} clicks at this rate.`
                    : 'Runs until you stop it with the trigger or the Stop button.');
            return `<div class="ac-card" style="--i:4;">
                <div class="ac-card-head">
                    <span class="ac-head-icon"><i class="fas fa-flag-checkered"></i></span>
                    <h4>How long</h4>
                </div>
                ${acSegHtml('ac-seg-repeat', AC_REPEATS, c.repeatMode, 'acSetRepeatMode')}
                ${extra}
                <p class="ac-note" style="margin-top:10px;">${esc(projected)}</p>
                <div class="ac-field" style="margin-top:14px;">
                    <div class="ac-slider-head"><label>Countdown before it starts</label><b>${c.startDelay ? acFormatDuration(c.startDelay) : 'none'}</b></div>
                    <input type="range" class="ac-slider" min="0" max="10000" step="250" value="${c.startDelay}"
                        oninput="acSliderLive(this, 'ms', 'none')" onchange="acPatch({ startDelay: +this.value })">
                    <p class="ac-note" style="margin-top:6px;">Gives you time to move the pointer or tab into a game after starting.</p>
                </div>
            </div>`;
        }

        function acTriggerHtml(c) {
            const conflict = acHotkeyConflict(c);
            return `<div class="ac-card" style="--i:5;">
                <div class="ac-card-head">
                    <span class="ac-head-icon"><i class="fas fa-keyboard"></i></span>
                    <h4>Trigger</h4>
                    <span class="ac-head-note">${c.enabled ? 'the key still reaches your game' : 'widget is off — hotkey inactive'}</span>
                </div>
                <div class="ac-trigger-row">
                    <button type="button" class="ac-arm ${c.armed ? 'on' : ''}" onclick="acToggleArmed()"
                        title="Turn the trigger hotkey on or off without disabling the widget">
                        <i class="fas ${c.armed ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>${c.armed ? 'Trigger enabled' : 'Trigger disabled'}
                    </button>
                    <button type="button" class="hotkey-bind no-drag" id="ac-hotkey-btn" onclick="acStartHotkeyBind()"
                        title="Click, then press a key or a side mouse button">${esc(acFormatHotkey(c.hotkey))}</button>
                    <select class="ac-select" onchange="acSetTrigger(this.value)">
                        <option value="toggle" ${c.trigger === 'toggle' ? 'selected' : ''}>Toggle — press to start, press to stop</option>
                        <option value="hold" ${c.trigger === 'hold' ? 'selected' : ''}>Hold — clicks only while held</option>
                    </select>
                </div>
                ${conflict ? `<div class="ac-warn"><i class="fas fa-triangle-exclamation" style="margin-top:2px;"></i>
                    <span>The trigger is <b>${esc(AC_MOUSE_LABELS[c.hotkey])}</b>, which is also the button being clicked — that would retrigger itself forever. Pick a different trigger or a different mouse button.</span></div>` : ''}
                ${!c.enabled ? `<p class="ac-note" style="margin-top:10px;">The widget is switched off, so the hotkey does nothing. The Start button above still works for testing.</p>` : ''}
            </div>`;
        }

        // ── After render: pill positions + the live preview ──
        function acAfterRender() {
            requestAnimationFrame(() => {
                acPositionPill('ac-seg-mode');
                acPositionPill('ac-seg-pattern');
                acPositionPill('ac-seg-clicktype');
                acPositionPill('ac-seg-repeat');
                acPositionPill('ac-seg-target');
            });
            acStartMap();
        }

        function acPositionPill(segId) {
            const seg = document.getElementById(segId);
            if (!seg) return;
            const pill = seg.querySelector('.ac-seg-pill');
            const active = seg.querySelector('.ac-seg-btn.on');
            if (!pill || !active) return;
            pill.style.width = `${active.offsetWidth}px`;
            pill.style.transform = `translateX(${active.offsetLeft - 3}px)`;
            requestAnimationFrame(() => pill.classList.remove('is-init'));
        }

        // ── Live preview canvas ──
        // Draws the region to scale and animates what the current settings would
        // actually do to it: scattered hits, the serpentine sweep path, or colour
        // blobs pinging as they're "detected".
        function acStartMap() {
            if (acMapRaf) { cancelAnimationFrame(acMapRaf); acMapRaf = null; }
            if (!document.getElementById('ac-map') || !acData) return;
            // Re-rendering for an unrelated edit shouldn't restart the sweep from
            // the top — only a change to what's actually being drawn does.
            const c = acData;
            const key = [c.mode, c.pattern, c.targetMode, c.color, c.color2, c.spacingX, c.spacingY,
                c.area && `${c.area.w}x${c.area.h}`,
                c.exclude && `${c.exclude.x},${c.exclude.y},${c.exclude.w},${c.exclude.h}`].join('|');
            if (!acMapState || acMapState.key !== key) {
                acMapState = { key, ripples: [], last: 0, spawn: 0, sweepIdx: 0, sweepAt: 0 };
            } else {
                acMapState.last = 0;   // the rAF clock restarts; don't bank a huge dt
            }
            acMapRaf = requestAnimationFrame(acDrawMap);
        }

        function acDrawMap(ts) {
            const cv = document.getElementById('ac-map');
            // The panel closed (or re-rendered without a map) — stop the loop.
            if (!cv || !acData || !acData.area) { acMapRaf = null; return; }

            const dpr = window.devicePixelRatio || 1;
            const cssW = cv.clientWidth || 320;
            const cssH = cv.clientHeight || 132;
            if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
                cv.width = Math.round(cssW * dpr);
                cv.height = Math.round(cssH * dpr);
            }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);

            const c = acData;
            const accent = acAccent();
            const st = acMapState || (acMapState = { key: '', ripples: [], last: ts, spawn: 0, sweepIdx: 0, sweepAt: 0 });
            const dt = Math.min(100, ts - (st.last || ts));
            st.last = ts;

            // Fit the region into the canvas, preserving its aspect ratio.
            const pad = 16;
            const availW = cssW - pad * 2;
            const availH = cssH - pad * 2;
            const scale = Math.min(availW / c.area.w, availH / c.area.h);
            const w = c.area.w * scale;
            const h = c.area.h * scale;
            const x0 = (cssW - w) / 2;
            const y0 = (cssH - h) / 2;

            // Region plate.
            ctx.save();
            acRoundRect(ctx, x0, y0, w, h, 6);
            ctx.fillStyle = `rgba(${accent}, 0.045)`;
            ctx.fill();
            ctx.strokeStyle = `rgba(${accent}, 0.42)`;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();

            // Skip zone in canvas space — the preview must obey it too, or it
            // would advertise clicks the engine will never make.
            let ez = null;
            if (c.mode === 'area' && c.exclude && c.area) {
                ez = {
                    x: x0 + (c.exclude.x - c.area.x) * scale,
                    y: y0 + (c.exclude.y - c.area.y) * scale,
                    w: c.exclude.w * scale,
                    h: c.exclude.h * scale
                };
            }
            const blocked = (px, py) => !!ez && px >= ez.x && px <= ez.x + ez.w && py >= ez.y && py <= ez.y + ez.h;

            if (c.mode === 'color') {
                acDrawColorPreview(ctx, c, st, dt, x0, y0, w, h, accent);
            } else if (c.pattern === 'sweep') {
                acDrawSweepPreview(ctx, c, st, dt, x0, y0, w, h, scale, accent, blocked);
            } else if (c.pattern === 'center') {
                if (!blocked(x0 + w / 2, y0 + h / 2)) {
                    acSpawnEvery(st, dt, 520, () => st.ripples.push({ x: x0 + w / 2, y: y0 + h / 2, age: 0 }));
                }
            } else {
                acSpawnEvery(st, dt, 190, () => {
                    for (let i = 0; i < 12; i++) {
                        const px = x0 + Math.random() * w;
                        const py = y0 + Math.random() * h;
                        if (!blocked(px, py)) { st.ripples.push({ x: px, y: py, age: 0 }); return; }
                    }
                });
            }

            if (ez) acDrawExclusion(ctx, ez);

            acPaintRipples(ctx, st, dt, c.mode === 'color' ? '74, 222, 128' : accent);
            acMapRaf = requestAnimationFrame(acDrawMap);
        }

        function acSpawnEvery(st, dt, everyMs, fn) {
            st.spawn += dt;
            while (st.spawn >= everyMs) {
                st.spawn -= everyMs;
                fn();
            }
        }

        function acPaintRipples(ctx, st, dt, rgb) {
            const alive = [];
            for (const r of st.ripples) {
                r.age += dt;
                const t = r.age / 620;
                if (t >= 1) continue;
                alive.push(r);
                ctx.save();
                ctx.beginPath();
                ctx.arc(r.x, r.y, 2 + t * 13, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${rgb}, ${(1 - t) * 0.75})`;
                ctx.lineWidth = 1.4;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(r.x, r.y, 2.4, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${rgb}, ${Math.max(0, 1 - t * 1.4)})`;
                ctx.fill();
                ctx.restore();
            }
            st.ripples = alive.slice(-40);
        }

        // Hatched keep-out box over the region.
        function acDrawExclusion(ctx, ez) {
            ctx.save();
            acRoundRect(ctx, ez.x, ez.y, ez.w, ez.h, 4);
            ctx.clip();
            ctx.fillStyle = 'rgba(10, 10, 10, 0.66)';
            ctx.fillRect(ez.x, ez.y, ez.w, ez.h);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
            ctx.lineWidth = 1;
            const step = 7;
            for (let i = -ez.h; i < ez.w + ez.h; i += step) {
                ctx.beginPath();
                ctx.moveTo(ez.x + i, ez.y);
                ctx.lineTo(ez.x + i + ez.h, ez.y + ez.h);
                ctx.stroke();
            }
            ctx.restore();
            ctx.save();
            acRoundRect(ctx, ez.x, ez.y, ez.w, ez.h, 4);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.restore();
        }

        function acDrawSweepPreview(ctx, c, st, dt, x0, y0, w, h, scale, accent, blocked) {
            // The same serpentine order the engine walks, sampled down so a huge
            // grid still draws legibly.
            if (!st.sweep || st.sweepW !== w || st.sweepKey !== `${c.spacingX}x${c.spacingY}`) {
                const pts = [];
                const stepX = Math.max(4, c.spacingX) * scale;
                const stepY = Math.max(4, c.spacingY) * scale;
                let row = 0;
                for (let y = y0 + stepY / 2; y < y0 + h; y += stepY) {
                    const line = [];
                    for (let x = x0 + stepX / 2; x < x0 + w; x += stepX) {
                        if (blocked && blocked(x, y)) continue;   // mirrors BuildSweep()
                        line.push([x, y]);
                    }
                    if (row % 2) line.reverse();
                    pts.push(...line);
                    row++;
                    if (pts.length > 900) break;
                }
                st.sweep = pts.length ? pts : [[x0 + w / 2, y0 + h / 2]];
                st.sweepW = w;
                st.sweepKey = `${c.spacingX}x${c.spacingY}`;
                st.sweepIdx = 0;
                st.sweepAt = 0;
            }

            const pts = st.sweep;
            if (!pts.length) return;
            // Draw the whole path faintly, then the travelled part brightly.
            ctx.save();
            ctx.strokeStyle = `rgba(${accent}, 0.16)`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.stroke();

            const head = Math.floor(st.sweepIdx);
            ctx.strokeStyle = `rgba(${accent}, 0.85)`;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            for (let i = 0; i <= Math.min(head, pts.length - 1); i++) {
                i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
            }
            ctx.stroke();

            for (let i = 0; i < pts.length; i++) {
                const done = i <= head;
                ctx.beginPath();
                ctx.arc(pts[i][0], pts[i][1], done ? 1.9 : 1.1, 0, Math.PI * 2);
                ctx.fillStyle = done ? `rgba(${accent}, 0.9)` : `rgba(${accent}, 0.25)`;
                ctx.fill();
            }
            ctx.restore();

            // Advance the head; each new cell fires a ripple.
            const perSec = 14;
            st.sweepAt += (dt / 1000) * perSec;
            while (st.sweepAt >= 1) {
                st.sweepAt -= 1;
                st.sweepIdx++;
                if (st.sweepIdx >= pts.length) st.sweepIdx = 0;
                const p = pts[Math.floor(st.sweepIdx)];
                if (p) st.ripples.push({ x: p[0], y: p[1], age: 0 });
            }
        }

        function acDrawColorPreview(ctx, c, st, dt, x0, y0, w, h, accent) {
            // A stable pseudo-random scatter of "targets" in the picked colour, so
            // the preview doesn't jitter between frames.
            if (!st.blobs || st.blobW !== w) {
                st.blobs = [];
                let seed = 8123;
                const rand = () => {
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                    return seed / 0x7fffffff;
                };
                const count = c.targetMode === 'all' ? 6 : 4;
                for (let i = 0; i < count; i++) {
                    st.blobs.push({
                        x: 0.12 + rand() * 0.76, y: 0.15 + rand() * 0.7, r: 4 + rand() * 5,
                        // With a second colour set, show both being hunted.
                        c: (c.color2 && i % 2) ? c.color2 : c.color
                    });
                }
                st.blobW = w;
                st.blobIdx = 0;
            }

            for (const b of st.blobs) {
                const bx = x0 + b.x * w;
                const by = y0 + b.y * h;
                ctx.save();
                ctx.beginPath();
                ctx.arc(bx, by, b.r + 3, 0, Math.PI * 2);
                ctx.fillStyle = acRgba(b.c || c.color, 0.16);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(bx, by, b.r, 0, Math.PI * 2);
                ctx.fillStyle = b.c || c.color;
                ctx.globalAlpha = 0.92;
                ctx.fill();
                ctx.restore();
            }

            // Scan line sweeping the region, and periodic "detections".
            st.scanY = ((st.scanY || 0) + dt * 0.00042) % 1;
            const sy = y0 + st.scanY * h;
            ctx.save();
            const grad = ctx.createLinearGradient(x0, sy - 10, x0, sy + 10);
            grad.addColorStop(0, `rgba(${accent}, 0)`);
            grad.addColorStop(0.5, `rgba(${accent}, 0.5)`);
            grad.addColorStop(1, `rgba(${accent}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(x0, sy - 10, w, 20);
            ctx.restore();

            acSpawnEvery(st, dt, c.targetMode === 'all' ? 260 : 700, () => {
                const b = st.blobs[st.blobIdx % st.blobs.length];
                st.blobIdx++;
                if (b) st.ripples.push({ x: x0 + b.x * w, y: y0 + b.y * h, age: 0 });
            });
        }

        function acRoundRect(ctx, x, y, w, h, r) {
            const rad = Math.min(r, w / 2, h / 2);
            ctx.beginPath();
            ctx.moveTo(x + rad, y);
            ctx.arcTo(x + w, y, x + w, y + h, rad);
            ctx.arcTo(x + w, y + h, x, y + h, rad);
            ctx.arcTo(x, y + h, x, y, rad);
            ctx.arcTo(x, y, x + w, y, rad);
            ctx.closePath();
        }

        // ── Colour helpers ──
        function acHexToRgb(hex) {
            const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
            if (!m) return { r: 255, g: 0, b: 0 };
            return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
        }

        function acShiftHex(rgb, delta) {
            const clamp = (v) => Math.max(0, Math.min(255, v + delta));
            return `rgb(${clamp(rgb.r)}, ${clamp(rgb.g)}, ${clamp(rgb.b)})`;
        }

        function acRgba(hex, alpha) {
            const c = acHexToRgb(hex);
            return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
        }

        // ── Actions ──
        // Every setter funnels through here: patch main, take back the sanitized
        // config it returns, re-render from that. The main process is the only
        // thing that decides what a valid value is.
        async function acPatch(patch) {
            if (!window.electronAPI?.autoClickerUpdate) return;
            try {
                acData = await window.electronAPI.autoClickerUpdate(patch);
            } catch (e) {
                console.error('Auto clicker update failed', e);
                return;
            }
            acRerender();
        }

        // Keeps a slider's own label in step while dragging, without a re-render.
        function acSliderLive(input, unit, zeroLabel, prefix) {
            const head = input.parentElement && input.parentElement.querySelector('.ac-slider-head b');
            if (!head) return;
            const v = Number(input.value);
            if (!v && zeroLabel) head.textContent = zeroLabel;
            else head.textContent = `${prefix || ''}${v}${unit ? ` ${unit}` : ''}`;
        }

        function acSetMode(mode) { acPatch({ mode }); }
        function acSetPattern(pattern) { acPatch({ pattern }); }
        function acSetClickType(clickType) { acPatch({ clickType }); }
        function acSetTarget(targetMode) { acPatch({ targetMode }); }
        function acSetRepeatMode(repeatMode) { acPatch({ repeatMode }); }
        function acSetButton(button) { acPatch({ button }); }
        function acClearExclusion() {
            acPatch({ exclude: null });
            showToast('Skip zone cleared');
        }

        function acClearColor2() {
            acScanResult = null;
            acPatch({ color2: null });
            showToast('Second colour removed');
        }

        function acSetColor2(value) {
            const v = String(value || '').trim();
            acScanResult = null;
            acPatch({ color2: /^#?[0-9a-fA-F]{6}$/.test(v) ? (v[0] === '#' ? v : `#${v}`) : acData.color2 });
        }

        function acSetColor(value) {
            const v = String(value || '').trim();
            acScanResult = null;
            acPatch({ color: /^#?[0-9a-fA-F]{6}$/.test(v) ? (v[0] === '#' ? v : `#${v}`) : acData.color });
        }

        function acReadTimeInputs(attr) {
            const read = (key) => {
                const el = document.querySelector(`[data-ac-${attr}="${key}"]`);
                const v = el ? Number(el.value) : 0;
                return Number.isFinite(v) && v > 0 ? v : 0;
            };
            return read('h') * 3600000 + read('m') * 60000 + read('s') * 1000 + read('ms');
        }

        function acSetInterval() {
            acPatch({ interval: Math.max(1, acReadTimeInputs('time')) });
        }

        function acSetDuration() {
            acPatch({ durationMs: Math.max(100, acReadTimeInputs('dur')) });
        }

        async function acToggleRun() {
            if (!acData) return;
            if (acData.running) {
                await window.electronAPI.autoClickerStop();
                return;
            }
            const blocker = acBlocker(acData);
            if (blocker) { showToast(blocker, true); return; }
            const result = await window.electronAPI.autoClickerStart();
            if (!result?.ok) {
                showToast(acStartErrorText(result?.error), true);
                return;
            }
            if (acData.startDelay) showToast(`Starting in ${acFormatDuration(acData.startDelay)}`);
        }

        function acStartErrorText(error) {
            if (error === 'no-area') return 'Select a region on screen first';
            if (error === 'no-point') return 'Pick the point to click first';
            if (error === 'area-too-large') return 'That region is too large — pick a smaller one';
            if (error === 'exclusion-covers-area') return 'The skip zone covers the whole region — nothing left to click';
            if (error === 'hotkey-is-click-button') return 'The trigger is the same button it would click — change one of them';
            if (error === 'busy') return 'Already running';
            return 'The click engine could not start';
        }

        async function acToggleArmed() {
            if (!acData) return;
            acData = await window.electronAPI.autoClickerSetArmed(!acData.armed);
            acRerender();
            showToast(acData.armed ? 'Trigger hotkey enabled' : 'Trigger hotkey disabled');
        }

        async function acSetTrigger(trigger) {
            await window.electronAPI.autoClickerSetTrigger(trigger);
            await renderAutoClickerPanel();
        }

        // Opens the on-screen picker. The launcher hides itself while it's up, so
        // the panel can't be re-rendered mid-pick — hence the acPicking guard.
        async function acPick(kind) {
            if (acPicking || !window.electronAPI?.autoClickerPick) return;
            acPicking = true;
            acRerender();
            let result;
            try {
                result = await window.electronAPI.autoClickerPick(kind, acAccent());
            } catch (e) {
                console.error('Auto clicker picker failed', e);
                result = { ok: false, error: 'picker-failed' };
            }
            acPicking = false;
            if (result?.config) acData = result.config;
            if (result?.ok) {
                acScanResult = null;
                showToast({
                    color: 'Colour picked',
                    color2: 'Second colour added',
                    point: 'Click point set',
                    exclude: 'Skip zone set',
                    area: 'Area selected'
                }[kind] || 'Selection saved');
            } else if (result && result.cancelled) {
                // Say so explicitly — the launcher hides during the pick, so
                // silence here looks like the app misbehaved.
                showToast('Selection cancelled');
            } else {
                showToast(result?.error === 'capture-failed' ? 'The screen could not be captured' : 'Selection failed', true);
            }
            if (acData) acRerender();
            else await renderAutoClickerPanel();
        }

        async function acTestScan() {
            if (!window.electronAPI?.autoClickerTestScan) return;
            acScanResult = { pending: true };
            acRerender();
            const result = await window.electronAPI.autoClickerTestScan();
            acScanResult = result;
            acRerender();
        }

        // ── Trigger hotkey binding ──
        // Same approach as Macros: capture-phase listeners that swallow the key so
        // it can't also do its normal job, plus a main-process pause so the engine's
        // own watcher doesn't fire a run from the key being bound.
        async function acStartHotkeyBind() {
            if (acBindActive) return;
            if (typeof bindingTarget !== 'undefined' && bindingTarget) {
                showToast('Already binding a hotkey. Press Esc to cancel.', true);
                return;
            }
            acBindActive = true;
            await disableAllHotkeys();
            if (window.electronAPI?.autoClickerSetBinding) await window.electronAPI.autoClickerSetBinding(true);
            const btn = document.getElementById('ac-hotkey-btn');
            if (btn) {
                btn.classList.add('listening');
                btn.textContent = 'press key / side button…';
            }
            showToast('Press a key or a side mouse button — Esc to cancel');
        }

        async function acEndBind() {
            acBindActive = false;
            if (window.electronAPI?.autoClickerSetBinding) await window.electronAPI.autoClickerSetBinding(false);
            await enableAllHotkeys();
        }

        async function acApplyHotkey(accelerator) {
            const result = await window.electronAPI.autoClickerSetHotkey(accelerator, acData ? acData.trigger : 'toggle');
            if (!result?.ok) {
                showToast(result?.error === 'hotkey-is-click-button'
                    ? 'That button is the one being clicked — pick another'
                    : 'That key can\'t be used as a trigger', true);
            } else {
                showToast(`Trigger set to ${acFormatHotkey(accelerator)}`);
            }
            await renderAutoClickerPanel();
        }

        document.addEventListener('mousedown', async (e) => {
            if (!acBindActive) return;
            const name = AC_MOUSE_HOTKEYS[e.button];
            if (!name) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.button === 2) {
                acSuppressContextMenu = true;
                setTimeout(() => { acSuppressContextMenu = false; }, 1000);
            }
            await acEndBind();
            await acApplyHotkey(name);
        }, true);

        document.addEventListener('contextmenu', (e) => {
            if (acSuppressContextMenu) {
                acSuppressContextMenu = false;
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        document.addEventListener('keydown', async (e) => {
            if (!acBindActive) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') {
                await acEndBind();
                await renderAutoClickerPanel();
                showToast('Binding cancelled');
                return;
            }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            await acEndBind();
            await acApplyHotkey(toElectronAccelerator(accel));
        }, true);

        // ── Live status from the engine ──
        // Progress arrives several times a second. Patch the readouts in place —
        // a full re-render at that rate would restart every animation and steal
        // focus from whatever field the user is editing.
        function acPaintLiveStatus(status) {
            const hero = document.getElementById('ac-hero');
            if (!hero) return;
            const stats = status.stats || {};
            const wasRunning = hero.dataset.state === 'running';
            if (wasRunning !== !!status.running) { acRerender(); return; }

            const setStat = (id, value) => {
                const cell = document.getElementById(id);
                if (!cell) return;
                const b = cell.querySelector('b');
                if (!b || b.textContent === value) return;
                b.textContent = value;
                cell.classList.remove('bump');
                void cell.offsetWidth;   // restart the bump animation
                cell.classList.add('bump');
            };
            setStat('ac-stat-clicks', String(stats.clicks || 0));
            setStat('ac-stat-time', acFormatDuration(stats.elapsed || 0));
            const live = stats.elapsed > 250 ? stats.clicks / (stats.elapsed / 1000) : 0;
            setStat('ac-stat-rate', acFormatRate(live || acRate(acData || status)));

            // Colour hunt: say whether it can currently see the target.
            if (acData && acData.mode === 'color' && status.running) {
                const sub = document.getElementById('ac-hero-sub');
                if (sub) {
                    const found = stats.found === true;
                    sub.innerHTML = `<span class="ac-hunt ${found ? 'found' : 'searching'}"><i></i>${found
                        ? `${stats.matches} match${stats.matches === 1 ? '' : 'es'} in view`
                        : 'searching for the colour…'}</span> · press <b>${esc(acFormatHotkey(status.hotkey))}</b> to stop`;
                }
            }
        }

        if (window.electronAPI?.onAutoClickerStatus) {
            window.electronAPI.onAutoClickerStatus((status) => {
                if (acData) {
                    acData.running = status.running;
                    acData.armed = status.armed;
                    acData.enabled = status.enabled;
                    acData.stats = status.stats;
                }
                if (!document.getElementById('autoclicker-panel')) return;
                if (status.event === 'progress' || status.event === 'hunt') {
                    acPaintLiveStatus(status);
                    return;
                }
                if (status.event === 'done') showToast(`Auto clicker finished — ${status.stats?.clicks || 0} clicks`);
                if (status.event === 'error') showToast('The click engine hit an error — see the log', true);
                renderAutoClickerPanel();
            });
        }
