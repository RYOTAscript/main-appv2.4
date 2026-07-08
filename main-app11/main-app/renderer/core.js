        const APP_VERSION = 'v3.13.0';
        const DEFAULT_HOTKEYS = { close: 'Escape', focus: 'Control+Alt+M', spotifyPlay: 'Control+Up', spotifyPause: 'Control+Down', spotifyNext: 'Control+Right', spotifyPrevious: 'Control+Left', spotifyVolumeUp: 'Control+PageUp', spotifyVolumeDown: 'Control+PageDown', micMute: 'Control+Shift+M' };

        // Registry of "Mini Widgets" -- small, self-contained utilities that each get
        // an enable toggle + a hotkey in Settings. Adding a future widget (Bluetooth
        // quick-connect, a macro tool, etc.) means adding one entry here plus its own
        // backend IPC handlers -- not touching the Settings/rendering scaffolding again.
        const MINI_WIDGETS = [
            {
                id: 'micMute',
                label: 'Mic Mute',
                icon: 'fa-microphone',
                description: 'Mute your microphone system-wide with a hotkey. Shows a small status overlay on screen, even outside the app.',
                defaultHotkey: 'Control+Shift+M'
            },
            {
                id: 'macros',
                label: 'Macros',
                icon: 'fa-keyboard',
                description: 'Record and replay mouse & keyboard actions system-wide, like TG Macro. Per-macro hotkeys with Pressed / Hold / Toggle / Released trigger modes, repeat counts, and playback speed.',
                // No single hotkey — each macro binds its own, managed in the panel below.
                panelId: 'macros-panel'
            },
            {
                id: 'clipboard',
                label: 'Clipboard History',
                icon: 'fa-clipboard',
                description: 'Keeps a running history of everything you copy so you can re-copy, pin, or delete past snippets.',
                panelId: 'clipboard-panel'
            },
            {
                id: 'spotifyEnhanced',
                label: 'Spotify Enhanced',
                icon: 'fa-headphones',
                description: 'Extends the Spotify player with a queue viewer, playlist shortcuts, recently played, and one-click like/unlike. Off by default; adds a heart button to the player when on.',
                panelId: 'spotify-enhanced-panel'
            },
            {
                id: 'screenResolution',
                label: 'Screen Resolution',
                icon: 'fa-display',
                description: 'Detect and instantly switch each monitor\'s resolution and refresh rate. Favourite the modes you use most; unsupported switches auto-revert after 15 seconds.',
                panelId: 'screen-resolution-panel'
            },
            {
                id: 'bluetooth',
                label: 'Bluetooth Manager',
                icon: 'fa-bluetooth-b',
                iconStyle: 'fab',
                description: 'See paired Bluetooth devices and their connection status, connect/disconnect or remove them, scan for and pair nearby devices, and view battery level where supported.',
                panelId: 'bluetooth-panel'
            }
        ];

        // A corrupted/partial localStorage value (e.g. from a crash mid-write) must
        // never throw here — an uncaught error at this point in the script would abort
        // the entire inline <script> block, leaving every function below undefined and
        // the whole app dead/blank. Fall back to the caller's default instead.
        function safeParseJSON(str, fallback) {
            if (!str) return fallback;
            try {
                const parsed = JSON.parse(str);
                return parsed === null || parsed === undefined ? fallback : parsed;
            } catch (e) {
                console.warn('Corrupted localStorage value, using default', e);
                return fallback;
            }
        }

        function bumpVersion(current, type) {
            const [major, minor, patch] = current.split('.').map(Number);
            if (type === 'bugfix') return `${major}.${minor}.${patch + 1}`;
            if (type === 'feature') return `${major}.${minor + 1}.0`;
            if (type === 'major') return `${major + 1}.0.0`;
            return current;
        }

