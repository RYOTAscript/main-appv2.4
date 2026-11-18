        // ── Draw on Screen ───────────────────────────────────────────────────
        // Draw over the screen from a hotkey: live, over whatever is running, or
        // on a frozen frame of it. main/screenDraw.js owns the overlay window
        // and the hotkeys; this file is only the Widget Library panel.

        let screenDrawPrefs = null;
        let screenDrawBinding = null;     // 'hotkey' | 'hotkeyAlt' while recording a shortcut

        // Called from applyMiniWidgetPrefs() when the widget toggle flips (and on
        // boot): main binds or drops the hotkeys.
        async function applyScreenDrawEnabled(enabled) {
            if (!window.electronAPI?.screenDrawSetEnabled) return;
            try {
                const p = await window.electronAPI.screenDrawSetEnabled(!!enabled);
                if (p && typeof p === 'object' && 'enabled' in p) {
                    screenDrawPrefs = p;
                    if (enabled && Array.isArray(p.failed) && p.failed.includes('hotkey')) {
                        showToast('Draw on Screen: another app already uses its hotkey — pick another one', true);
                    }
                }
            } catch (e) { /* main logs it */ }
            renderScreenDrawPanel();
        }

        async function setScreenDrawPref(key, value) {
            if (!window.electronAPI?.screenDrawSetPrefs) return null;
            try {
                const p = await window.electronAPI.screenDrawSetPrefs({ [key]: value });
                if (p && typeof p === 'object' && 'enabled' in p) screenDrawPrefs = p;
                renderScreenDrawPanel();
                return p;
            } catch (e) {
                return null;
            }
        }

        function startScreenDraw(mode) {
            if (!window.electronAPI?.screenDrawOpen) return;
            window.electronAPI.screenDrawOpen(mode).catch(() => {});
        }

        function screenDrawHotkeyText(accel) {
            if (!accel) return 'Not set';
            const raw = accel.replace(/CommandOrControl/g, 'Control');
            return typeof formatHotkeyDisplay === 'function' ? formatHotkeyDisplay(raw) : raw;
        }

        // ── Config panel (Widget Library detail view) ───────────────────────────
        // No-ops unless its div is on screen (only present while the detail is open).
        function renderScreenDrawPanel() {
            const panel = document.getElementById('screen-draw-panel');
            if (!panel) return;
            const p = screenDrawPrefs || { enabled: false, hotkey: 'CommandOrControl+Alt+D', hotkeyAlt: '', mode: 'live', freezeAvailable: true };
            const other = p.mode === 'freeze' ? 'Live' : 'Freeze';

            const seg = (current, options) => options.map(o =>
                `<button type="button" class="fsl-seg-btn${current === o.value ? ' is-on' : ''} no-drag"` +
                ` onclick="setScreenDrawPref('mode',${jsAttr(o.value)})">` +
                `<i class="fas ${o.icon}"></i><span>${o.label}</span></button>`
            ).join('');
            const hotkeyRow = (key, label) => {
                const listening = screenDrawBinding === key;
                const value = listening ? 'Press a shortcut…' : screenDrawHotkeyText(p[key]);
                const action = listening ? 'endScreenDrawBind()' : `bindScreenDrawHotkey(${jsAttr(key)})`;
                return `<div class="fsl-cfg-row"><span class="fsl-cfg-label">${label}</span>` +
                    `<div class="sdraw-keys">` +
                        `<span class="sdraw-kbd${listening ? ' is-listening' : ''}">${esc(value)}</span>` +
                        `<button type="button" class="fsl-seg-btn no-drag" onclick="${action}">${listening ? 'Cancel' : 'Set'}</button>` +
                        (p[key] && !listening
                            ? `<button type="button" class="fsl-seg-btn no-drag" title="Clear this shortcut" onclick="setScreenDrawPref(${jsAttr(key)},'')"><i class="fas fa-xmark"></i></button>`
                            : '') +
                    `</div></div>`;
            };

            panel.innerHTML =
                `<div class="fsl-cfg">` +
                    (p.freezeAvailable ? '' :
                        `<div class="fsl-cfg-note"><i class="fas fa-triangle-exclamation"></i>` +
                        `<span>To <b>freeze</b> the screen, allow main under System Settings ▸ Privacy &amp; Security ▸ <b>Screen Recording</b>. Drawing live works without it.</span></div>`) +
                    hotkeyRow('hotkey', 'Hotkey') +
                    `<div class="fsl-cfg-row"><span class="fsl-cfg-label">It opens</span><div class="fsl-seg">` +
                        seg(p.mode, [
                            { value: 'live', icon: 'fa-pen', label: 'Live' },
                            { value: 'freeze', icon: 'fa-snowflake', label: 'Frozen' }
                        ]) +
                    `</div></div>` +
                    hotkeyRow('hotkeyAlt', `${other} hotkey`) +
                    `<div class="sdraw-start">` +
                        `<button type="button" class="fsl-cfg-open no-drag" onclick="startScreenDraw('live')"${p.enabled ? '' : ' disabled'}><i class="fas fa-pen"></i><span>Draw live</span></button>` +
                        `<button type="button" class="fsl-cfg-open no-drag" onclick="startScreenDraw('freeze')"${p.enabled && p.freezeAvailable ? '' : ' disabled'}><i class="fas fa-snowflake"></i><span>Freeze &amp; draw</span></button>` +
                    `</div>` +
                    `<p class="fsl-cfg-hint">` +
                        `<b>Live</b> draws over whatever is running — videos keep playing underneath, and <b>T</b> lets clicks through to your apps while the drawing stays. ` +
                        `<b>Frozen</b> takes a still of the screen first and you draw on that. <b>F</b> switches between them any time.<br>` +
                        `Pen <b>P</b> · Highlighter <b>H</b> · Laser <b>K</b> · Arrow <b>A</b> · Line <b>L</b> · Box <b>R</b> · Ellipse <b>O</b> · Eraser <b>E</b> · ` +
                        `colours <b>1–8</b> · size <b>[ ]</b> · Shift keeps shapes straight · <b>Ctrl+Z</b> undo · <b>Ctrl+S</b> save · <b>Ctrl+C</b> copy · <b>Esc</b> close.` +
                    `</p>` +
                `</div>`;
        }

        // ── Recording a hotkey ──────────────────────────────────────────────────

        async function bindScreenDrawHotkey(key) {
            if (screenDrawBinding || (typeof bindingTarget !== 'undefined' && bindingTarget)) return;
            screenDrawBinding = key;
            if (typeof disableAllHotkeys === 'function') await disableAllHotkeys();
            window.addEventListener('keydown', screenDrawBindListener, true);
            renderScreenDrawPanel();
            showToast('Press a shortcut — Esc to cancel');
        }

        async function endScreenDrawBind() {
            window.removeEventListener('keydown', screenDrawBindListener, true);
            screenDrawBinding = null;
            if (typeof enableAllHotkeys === 'function') await enableAllHotkeys();
            renderScreenDrawPanel();
        }

        async function screenDrawBindListener(e) {
            if (!screenDrawBinding) return;
            // Capture phase on window runs before every document listener, so the
            // Widget Library and the app's close key never see this press.
            e.preventDefault();
            e.stopImmediatePropagation();
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const key = screenDrawBinding;
            if (e.key === 'Escape') {
                await endScreenDrawBind();
                showToast('Cancelled');
                return;
            }
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const isFKey = /^F\d{1,2}$/.test(accel.split('+').pop());
            if (!isFKey && !(e.ctrlKey || e.altKey || e.metaKey)) {
                showToast('Use Ctrl or Alt with a key — or an F-key', true);
                return;
            }
            const electronAccel = toElectronAccelerator(accel);
            const otherKey = key === 'hotkey' ? 'hotkeyAlt' : 'hotkey';
            const takenInApp = typeof hotkeys === 'object' && hotkeys && Object.values(hotkeys).includes(accel);
            await endScreenDrawBind();
            if (takenInApp || (screenDrawPrefs && screenDrawPrefs[otherKey] === electronAccel)) {
                showToast('That shortcut is already used in main', true);
                return;
            }
            const res = await setScreenDrawPref(key, electronAccel);
            if (res && Array.isArray(res.failed) && res.failed.includes(key)) {
                showToast('Another app already uses that shortcut', true);
                await setScreenDrawPref(key, '');
                return;
            }
            showToast(`Draw on Screen: ${screenDrawHotkeyText(electronAccel)}`);
        }

        if (window.electronAPI?.onScreenDrawChanged) {
            window.electronAPI.onScreenDrawChanged((p) => {
                if (p && typeof p === 'object' && 'enabled' in p) {
                    screenDrawPrefs = p;
                    renderScreenDrawPanel();
                }
            });
        }
