        const DEFAULT_APPS = [
            { name: "Rainbow Six Siege", path: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tom Clancy's Rainbow Six Siege\\RainbowSix.exe", icon: "siege.ico" },
            { name: "Spotify", path: "C:\\Users\\ivanq\\AppData\\Roaming\\Spotify\\Spotify.exe", icon: "spotify.ico" },
            { name: "Discord", path: "C:\\Users\\ivanq\\AppData\\Local\\Discord\\Update.exe", icon: "discord.ico" },
            { name: "Valorant", path: "C:\\Riot Games\\Riot Client\\RiotClientServices.exe", icon: "valorant.ico" },
            { name: "Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", icon: "chrome.ico" }
        ];

        let pinnedApps = safeParseJSON(localStorage.getItem('pinnedApps'), DEFAULT_APPS);
        // Migration: FPS Optimizer used to be a special pinned "app" (path
        // "fps-optimizer") that opened a modal. It's now a Widget Library mini
        // widget, so drop that pseudo-pin from anyone's saved launcher.
        if (Array.isArray(pinnedApps) && pinnedApps.some(a => a && a.path === 'fps-optimizer')) {
            pinnedApps = pinnedApps.filter(a => !(a && a.path === 'fps-optimizer'));
            try { localStorage.setItem('pinnedApps', JSON.stringify(pinnedApps)); } catch (e) { /* non-fatal */ }
        }
        let draggedIndex = null;
        let lastCpu = null;
        let lastRam = null;
        let statsInterval = null;
        let settingsSaveTimer = null;
        let hotkeys = safeParseJSON(localStorage.getItem('hotkeys'), null) || { ...DEFAULT_HOTKEYS };
        // Fix invalid stored hotkeys
        if (hotkeys.spotifyNext === 'Right') hotkeys.spotifyNext = 'Control+Right';
        let bindingTarget = null;

        function formatHotkeyDisplay(accelerator) {
            if (!accelerator) return '-';
            return accelerator
                .replace(/Control/g, 'Ctrl')
                .replace(/Command/g, 'Win')
                .replace(/Escape/g, 'Esc')
                .replace(/ArrowUp/g, '↑')
                .replace(/ArrowDown/g, '↓')
                .replace(/ArrowLeft/g, '←')
                .replace(/ArrowRight/g, '→')
                .replace(/\bUp\b/g, '↑')
                .replace(/\bDown\b/g, '↓')
                .replace(/\bLeft\b/g, '←')
                .replace(/\bRight\b/g, '→');
        }

        function normalizeArrowKey(key) {
            if (key === 'ArrowUp') return 'Up';
            if (key === 'ArrowDown') return 'Down';
            if (key === 'ArrowLeft') return 'Left';
            if (key === 'ArrowRight') return 'Right';
            return key;
        }

        function keyEventToAccelerator(e) {
            const parts = [];
            if (e.ctrlKey) parts.push('Control');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Command');

            let key = e.key;
            if (key === ' ') key = 'Space';
            key = normalizeArrowKey(key);
            if (key.length === 1) key = key.toUpperCase();
            if (['Control', 'Alt', 'Shift', 'Meta', 'Command'].includes(key)) {
                return null;
            }

            parts.push(key);
            return parts.join('+');
        }

        function keydownMatches(e, accelerator) {
            // '-' is the "unbound" sentinel written by hotkey-conflict resolution —
            // it must never match a real keypress (it would otherwise bind the minus key).
            if (!accelerator || accelerator === '-') return false;
            const parts = accelerator.split('+');
            const keyPart = parts[parts.length - 1];
            const needCtrl = parts.includes('Control') || parts.includes('CommandOrControl');
            const needAlt = parts.includes('Alt');
            const needShift = parts.includes('Shift');
            const needMeta = parts.includes('Command') || parts.includes('CommandOrControl');

            let eventKey = e.key;
            if (eventKey === ' ') eventKey = 'Space';
            eventKey = normalizeArrowKey(eventKey);
            if (eventKey.length === 1) eventKey = eventKey.toUpperCase();

            return (
                e.ctrlKey === needCtrl &&
                e.altKey === needAlt &&
                e.shiftKey === needShift &&
                e.metaKey === needMeta &&
                eventKey === keyPart
            );
        }

        function camelToKebab(str) {
            return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        }

        function getHotkeyButtonId(type) {
            return `hotkey-${camelToKebab(type)}-btn`;
        }

        function updateHotkeyDisplays() {
            const ids = ['focus', 'close', 'spotifyPlay', 'spotifyPause', 'spotifyNext', 'spotifyPrevious', 'spotifyVolumeUp', 'spotifyVolumeDown', 'micMute', 'crosshair', 'voiceAssistant'];
            for (const type of ids) {
                const btn = document.getElementById(getHotkeyButtonId(type));
                if (btn) btn.textContent = formatHotkeyDisplay(hotkeys[type] || DEFAULT_HOTKEYS[type]);
            }

            // Transport button tooltips — always reflect the current binding.
            // Play/pause gets special handling: if both share the same modifiers
            // (e.g. Ctrl+; and Ctrl+') we show "Ctrl+; / '" — modifier only once.
            // If they differ (e.g. Ctrl+; and Alt+') we show them fully: "Ctrl+; / Alt+'".
            const playAcc  = hotkeys.spotifyPlay  || DEFAULT_HOTKEYS.spotifyPlay;
            const pauseAcc = hotkeys.spotifyPause || DEFAULT_HOTKEYS.spotifyPause;
            document.getElementById('spotify-prev-btn')  && (document.getElementById('spotify-prev-btn').title  = formatHotkeyDisplay(hotkeys.spotifyPrevious || DEFAULT_HOTKEYS.spotifyPrevious));
            document.getElementById('spotify-next-btn')  && (document.getElementById('spotify-next-btn').title  = formatHotkeyDisplay(hotkeys.spotifyNext    || DEFAULT_HOTKEYS.spotifyNext));
            document.getElementById('spotify-play-btn')  && (document.getElementById('spotify-play-btn').title  = formatPairedHotkeyDisplay(playAcc, pauseAcc));

            updateFooterHotkeys();
        }

        // Formats two accelerators into a single compact tooltip string.
        // When both share identical modifier(s), the modifier is shown only once:
        //   "Control+;" + "Control+'"  →  "Ctrl+; / '"
        //   "Control+;" + "Alt+'"      →  "Ctrl+; / Alt+'"  (different mods, show both)
        //   "Control+;" + ""           →  "Ctrl+;"          (only one binding set)
        function formatPairedHotkeyDisplay(accA, accB) {
            if (!accA && !accB) return '-';
            if (!accA) return formatHotkeyDisplay(accB);
            if (!accB) return formatHotkeyDisplay(accA);
            if (accA === accB) return formatHotkeyDisplay(accA);

            const MODIFIER_TOKENS = new Set(['Control', 'Alt', 'Shift', 'Command', 'Meta', 'Super']);

            function split(acc) {
                const parts = acc.split('+');
                const mods = parts.slice(0, -1).filter(p => MODIFIER_TOKENS.has(p));
                const key  = parts[parts.length - 1];
                return { mods, key };
            }

            const a = split(accA);
            const b = split(accB);

            const modsMatch =
                a.mods.length === b.mods.length &&
                a.mods.every((m, i) => m === b.mods[i]);

            const formattedA = formatHotkeyDisplay(accA);
            if (modsMatch) {
                // Same modifiers: show full first hotkey, then just the bare key for the second.
                const bareKey = formatHotkeyDisplay(b.key);
                return `${formattedA} / ${bareKey}`;
            } else {
                return `${formattedA} / ${formatHotkeyDisplay(accB)}`;
            }
        }

        async function disableAllHotkeys() {
            if (window.electronAPI?.disableAllHotkeys) {
                await window.electronAPI.disableAllHotkeys();
            }
        }

        async function enableAllHotkeys() {
            if (window.electronAPI?.enableAllHotkeys) {
                await window.electronAPI.enableAllHotkeys();
            }
        }

        function updateFooterHotkeys() {
            const el = document.getElementById('footer-hotkeys');
            if (!el) return;
            el.textContent = `${formatHotkeyDisplay(hotkeys.close)} close · ${formatHotkeyDisplay(hotkeys.focus)} focus`;
        }

        function startHotkeyBind(type) {
            if (bindingTarget) {
                showToast('Already binding a hotkey. Press Esc to cancel.', true);
                return;
            }
            bindingTarget = type;
            disableAllHotkeys();
            const btn = document.getElementById(getHotkeyButtonId(type));
            if (btn) {
                btn.classList.add('listening');
                btn.textContent = 'press key…';
            }
            showToast(type === 'close' ? 'Press a key combination' : 'Press a key combination or Esc to revert');
        }

        function cancelHotkeyBind() {
            if (!bindingTarget) return;
            const type = bindingTarget;
            bindingTarget = null;
            enableAllHotkeys();
            const btn = document.getElementById(getHotkeyButtonId(type));
            if (btn) btn.classList.remove('listening');
            updateHotkeyDisplays();
        }

        async function applyFocusHotkey(accelerator) {
            if (!window.electronAPI?.setFocusHotkey) return false;
            const result = await window.electronAPI.setFocusHotkey(accelerator);
            // A global binding on a near-universal key does not feel like a
            // hotkey, it feels like the app appearing at random. Say so at the
            // moment it is chosen, while the user still has it in mind.
            if (result?.warning && typeof showToast === 'function') {
                showToast(result.warning, 'warning');
            }
            return result?.success;
        }

        // Tells the main process to release the focus hotkey entirely, used when
        // another category's binding wins a conflict against it (see the binding
        // handler in spotify-widget.js). set-focus-hotkey deliberately rejects '-'
        // (it's not a real accelerator), so releasing needs its own IPC.
        async function releaseFocusHotkeyFromMain() {
            if (window.electronAPI?.unregisterFocusHotkey) {
                await window.electronAPI.unregisterFocusHotkey();
            }
        }

        function toElectronAccelerator(accelerator) {
            if (!accelerator || typeof accelerator !== 'string') return accelerator;
            return accelerator
                .replace(/ArrowUp/g, 'Up')
                .replace(/ArrowDown/g, 'Down')
                .replace(/ArrowLeft/g, 'Left')
                .replace(/ArrowRight/g, 'Right')
                .replace(/Control/g, 'CommandOrControl')
                .replace(/Meta/g, 'CommandOrControl');
        }

        async function sendSpotifyHotkeysToMain() {
            if (!window.electronAPI?.registerSpotifyShortcuts) return;
            const spotifyHotkeys = {
                spotifyPlay: toElectronAccelerator(hotkeys.spotifyPlay || DEFAULT_HOTKEYS.spotifyPlay),
                spotifyPause: toElectronAccelerator(hotkeys.spotifyPause || DEFAULT_HOTKEYS.spotifyPause),
                spotifyNext: toElectronAccelerator(hotkeys.spotifyNext || DEFAULT_HOTKEYS.spotifyNext),
                spotifyPrevious: toElectronAccelerator(hotkeys.spotifyPrevious || DEFAULT_HOTKEYS.spotifyPrevious),
                spotifyVolumeUp: toElectronAccelerator(hotkeys.spotifyVolumeUp || DEFAULT_HOTKEYS.spotifyVolumeUp),
                spotifyVolumeDown: toElectronAccelerator(hotkeys.spotifyVolumeDown || DEFAULT_HOTKEYS.spotifyVolumeDown)
            };
            await window.electronAPI.registerSpotifyShortcuts(spotifyHotkeys);
        }

        async function sendMicMuteHotkeyToMain() {
            if (!window.electronAPI?.registerMicMuteHotkey) return;
            await window.electronAPI.registerMicMuteHotkey(toElectronAccelerator(hotkeys.micMute || DEFAULT_HOTKEYS.micMute));
        }

        // The voice assistant stores its hotkey with the rest of its settings (it
        // needs the raw "Control+..." form to watch the key for hold-to-talk, not
        // just to register an accelerator), so it syncs through its settings API
        // rather than a dedicated register-hotkey channel.
        async function sendVoiceAssistantHotkeyToMain() {
            if (!window.electronAPI?.voiceSettingsSet) return;
            await window.electronAPI.voiceSettingsSet({
                hotkey: hotkeys.voiceAssistant || DEFAULT_HOTKEYS.voiceAssistant
            });
        }

        async function sendCrosshairHotkeyToMain() {
            if (!window.electronAPI?.registerCrosshairHotkey) return;
            await window.electronAPI.registerCrosshairHotkey(toElectronAccelerator(hotkeys.crosshair || DEFAULT_HOTKEYS.crosshair));
        }

        async function initHotkeys() {
            updateHotkeyDisplays();
            if (window.electronAPI?.setFocusHotkey) {
                const ok = await applyFocusHotkey(hotkeys.focus);
                if (!ok) {
                    hotkeys.focus = DEFAULT_HOTKEYS.focus;
                    localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
                    await applyFocusHotkey(hotkeys.focus);
                    updateHotkeyDisplays();
                }
            }
            await sendSpotifyHotkeysToMain();
            await sendMicMuteHotkeyToMain();
            await sendCrosshairHotkeyToMain();
            await sendVoiceAssistantHotkeyToMain();
        }
