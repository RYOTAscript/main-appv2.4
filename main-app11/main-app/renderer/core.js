        const APP_VERSION = 'v3.40.0';
        const DEFAULT_HOTKEYS = { close: 'Escape', focus: 'Control+Alt+M', spotifyPlay: 'Control+Up', spotifyPause: 'Control+Down', spotifyNext: 'Control+Right', spotifyPrevious: 'Control+Left', spotifyVolumeUp: 'Control+PageUp', spotifyVolumeDown: 'Control+PageDown', micMute: 'Control+Shift+M', crosshair: 'Control+Shift+X' };

        // Registry of "Mini Widgets" -- small, self-contained utilities. This is the
        // SINGLE SOURCE OF TRUTH: the Widget Library (browse/search/favourite), the
        // dashboard Mini Widgets strip, and the enable/hotkey wiring are all generated
        // from these entries. Adding a future widget means adding one entry here (plus
        // its own backend IPC handlers) -- no UI scaffolding needs touching again.
        //
        // Metadata fields:
        //   id            internal key (also the miniWidgetPrefs / favourites key)
        //   label         display name
        //   icon          Font Awesome icon class (e.g. 'fa-microphone')
        //   iconStyle     FA family prefix, default 'fas' (use 'fab' for brand icons)
        //   description   short one-liner shown on cards
        //   longDescription  full paragraph shown in the detail panel (falls back to
        //                    description when omitted)
        //   category      one of MINI_WIDGET_CATEGORIES — drives category filtering
        //   keywords      extra search terms (names/description/category are always
        //                 searched; keywords catch synonyms users might type)
        //   version       widget version string, shown on cards + detail
        //   author        credited in the detail panel
        //   features      bullet list of capabilities, shown in the detail panel
        //   defaultHotkey optional global hotkey; renders a bind button
        //   panelId       optional id of the config panel hosted in the detail view
        //   panelRenderer optional name of the global function that fills panelId
        const MINI_WIDGETS = [
            {
                id: 'micMute',
                label: 'Mic Mute',
                icon: 'fa-microphone',
                description: 'Mute your microphone system-wide with a hotkey, with an on-screen status overlay.',
                longDescription: 'Mute your microphone system-wide with a hotkey. Shows a small status overlay on screen, even outside the app, so you always know whether you are live.',
                category: 'Audio',
                keywords: ['mic', 'microphone', 'mute', 'audio', 'voice', 'push to talk', 'overlay'],
                version: '1.0.0',
                author: 'ryota',
                features: ['System-wide mute hotkey', 'Always-on-top status overlay', 'Works outside the app'],
                defaultHotkey: 'Control+Shift+M'
            },
            {
                id: 'macros',
                label: 'Macros',
                icon: 'fa-keyboard',
                description: 'Record and replay mouse & keyboard actions system-wide, with per-macro hotkeys.',
                longDescription: 'Record and replay mouse & keyboard actions system-wide, like TG Macro. Per-macro hotkeys with Pressed / Hold / Toggle / Released trigger modes, repeat counts, and playback speed.',
                category: 'Productivity',
                keywords: ['macro', 'automation', 'keyboard', 'mouse', 'record', 'replay', 'tg macro', 'hotkey'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Record mouse & keyboard', 'Per-macro hotkeys', 'Pressed / Hold / Toggle / Released modes', 'Repeat counts & playback speed'],
                // No single hotkey — each macro binds its own, managed in the panel below.
                panelId: 'macros-panel',
                panelRenderer: 'renderMacrosPanel'
            },
            {
                id: 'controllerMacros',
                label: 'Controller Macros',
                icon: 'fa-gamepad',
                description: 'Press PlayStation/Xbox controller buttons for you — combos games really see.',
                longDescription: 'Presses controller buttons for you — for real. A virtual PlayStation (DualShock 4) or Xbox 360 pad is plugged into Windows through the free ViGEmBus driver, and your macros press ✕ / □ / L2 / R1 on it, so games react exactly as if you did. Stick moves get a visual joystick pad — drag the knob or tap a direction instead of typing numbers — which makes flick- and aim-heavy games (Skate, Siege, Fortnite) far easier to build combos for, and one-click templates give you working starters, including a full Skate Flick-It trick library and NBA 2K26 Pro Stick dribble moves, shots & dunks. Build combos step by step or record them from a real controller, then fire them with per-macro hotkeys — Pressed / Hold / Toggle / Released modes, repeat counts and playback speed, just like the Macros widget. Heads up: some anti-cheat titles may ignore or dislike virtual controllers.',
                category: 'Gaming',
                keywords: ['controller', 'gamepad', 'playstation', 'ps4', 'ps5', 'dualshock', 'xbox', 'combo', 'macro', 'vigem', 'button', 'virtual', 'x square l2 r1', 'stick', 'joystick', 'aim', 'flick', 'skate', 'siege', 'fortnite', 'template', 'nba', '2k', '2k26', 'basketball', 'dribble', 'crossover', 'pro stick', 'dunk'],
                version: '1.2.0',
                author: 'ryota',
                features: ['Virtual PlayStation or Xbox 360 pad games really see', 'Visual joystick pad — drag or tap 8-way directions for sticks', 'Skate Classic Flick-It template library (flips, shove-its, spins, grabs, manuals)', 'NBA 2K26 Pro Stick templates (dribble moves, turbo moves, shots & dunks)', 'Step editor: taps, holds, trigger pulls & stick moves', 'Record combos from a real controller', 'Pressed / Hold / Toggle / Released hotkey modes', 'Repeat counts & playback speed'],
                panelId: 'controller-macros-panel',
                panelRenderer: 'renderControllerMacrosPanel'
            },
            {
                id: 'clipboard',
                label: 'Clipboard History',
                icon: 'fa-clipboard',
                description: 'A running history of everything you copy — text, images, and files.',
                longDescription: 'Keeps a running history of everything you copy — text, images, and files — so you can re-copy, pin, or delete past items.',
                category: 'Clipboard',
                keywords: ['clipboard', 'copy', 'paste', 'history', 'snippets', 'images', 'files'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Tracks text, images & files', 'Re-copy any past item', 'Pin favourites', 'Delete individual entries'],
                panelId: 'clipboard-panel',
                panelRenderer: 'renderClipboardPanel'
            },
            {
                id: 'spotifyEnhanced',
                label: 'Spotify Enhanced',
                icon: 'fa-headphones',
                description: 'Adds a queue viewer, playlist shortcuts, recently played, and one-click like.',
                longDescription: 'Extends the Spotify player with a queue viewer, playlist shortcuts, recently played, and one-click like/unlike. Off by default; adds a heart button to the player when on.',
                category: 'Spotify',
                keywords: ['spotify', 'music', 'queue', 'playlist', 'like', 'recently played', 'player'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Queue viewer', 'Playlist shortcuts', 'Recently played', 'One-click like / unlike'],
                panelId: 'spotify-enhanced-panel',
                panelRenderer: 'renderSpotifyEnhancedPanel'
            },
            {
                id: 'screenResolution',
                label: 'Screen Resolution',
                icon: 'fa-display',
                description: 'Instantly switch each monitor\'s resolution and refresh rate, with favourites.',
                longDescription: 'Detect and instantly switch each monitor\'s resolution and refresh rate. Favourite the modes you use most; unsupported switches auto-revert after 15 seconds.',
                category: 'Displays',
                keywords: ['display', 'monitor', 'resolution', 'refresh rate', 'hz', 'screen', 'multi-monitor'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Per-monitor resolution & refresh rate', 'Favourite your most-used modes', 'Auto-revert unsupported switches'],
                panelId: 'screen-resolution-panel',
                panelRenderer: 'renderScreenResolutionPanel'
            },
            {
                id: 'bluetooth',
                label: 'Bluetooth Manager',
                icon: 'fa-bluetooth-b',
                iconStyle: 'fab',
                description: 'Connect, disconnect, pair and remove Bluetooth devices, with battery levels.',
                longDescription: 'See paired Bluetooth devices and their connection status, connect/disconnect or remove them, scan for and pair nearby devices, and view battery level where supported.',
                category: 'System',
                keywords: ['bluetooth', 'device', 'headphones', 'pair', 'connect', 'wireless', 'battery'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Connect / disconnect paired devices', 'Scan for and pair nearby devices', 'Remove devices', 'Battery level where supported'],
                panelId: 'bluetooth-panel',
                panelRenderer: 'renderBluetoothPanel'
            },
            {
                id: 'videoEditor',
                label: 'Video Editor',
                icon: 'fa-film',
                description: 'A fast, simple video trimmer with lossless or frame-accurate export.',
                longDescription: 'A fast, simple video trimmer. Import a clip, set in/out points on the timeline, keep or drop audio, and export losslessly (or with a precise frame-accurate re-encode). Powered by bundled FFmpeg.',
                category: 'Media',
                keywords: ['video', 'editor', 'trim', 'clip', 'ffmpeg', 'export', 'cut', 'timeline'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Timeline in/out trimming', 'Keep or drop audio', 'Lossless or frame-accurate export', 'Bundled FFmpeg'],
                panelId: 'video-editor-panel',
                panelRenderer: 'renderVideoEditorPanel'
            },
            {
                id: 'crosshair',
                label: 'Crosshair',
                icon: 'fa-crosshairs',
                description: 'Draws a customizable crosshair at screen centre, above every window.',
                longDescription: 'Draws a customizable crosshair in the center of your screen, above every window — for games without one or with one that\'s hard to see. Pick a style, color, size, gap and opacity; toggle it with a hotkey.',
                category: 'Gaming',
                keywords: ['crosshair', 'aim', 'gaming', 'overlay', 'reticle', 'fps', 'valorant'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Always-on-top centre crosshair', 'Style, colour, size, gap & opacity', 'Toggle with a hotkey'],
                defaultHotkey: 'Control+Shift+X',
                panelId: 'crosshair-panel',
                panelRenderer: 'renderCrosshairPanel'
            },
            {
                id: 'weatherEnhanced',
                label: 'Weather Enhanced',
                icon: 'fa-cloud-sun-rain',
                description: 'Feels-like, humidity, wind and a 3-day forecast, with a manual city override.',
                longDescription: 'Extends the header weather readout with a full detail panel: current conditions with feels-like temperature, humidity and wind, plus a 3-day forecast. Reads your location automatically or pin any city by name, and refresh on demand. Uses the same weather service as the header, so units follow your existing °C/°F setting.',
                category: 'Weather',
                keywords: ['weather', 'forecast', 'temperature', 'humidity', 'wind', 'feels like', 'city', 'rain', 'climate'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Feels-like, humidity & wind', '3-day forecast', 'Manual city override', 'Refresh on demand', 'Follows your °C/°F setting'],
                panelId: 'weather-enhanced-panel',
                panelRenderer: 'renderWeatherEnhancedPanel'
            },
            {
                id: 'timer',
                label: 'Countdown Timer',
                icon: 'fa-hourglass-half',
                description: 'A countdown timer with quick presets that keeps ticking on the dashboard.',
                longDescription: 'A simple countdown timer with one-tap presets (1, 5, 10, 25 minutes and more) or a custom duration. Start, pause, resume and reset from the panel; while it runs, a live readout sits in the header so you can watch it from anywhere in the app. Alerts you with a sound and a toast when time is up.',
                category: 'Productivity',
                keywords: ['timer', 'countdown', 'stopwatch', 'pomodoro', 'alarm', 'minutes', 'reminder', 'cooking'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Countdown to zero', 'Quick presets + custom duration', 'Start / Pause / Resume / Reset', 'Live header readout while running', 'Sound + toast when time is up'],
                panelId: 'timer-panel',
                panelRenderer: 'renderTimerPanel'
            },
            {
                id: 'notesEnhanced',
                label: 'Quick Notes Enhanced',
                icon: 'fa-note-sticky',
                description: 'Turns Quick Notes into a multi-note editor with tabs, checklists, Markdown & history.',
                longDescription: 'Upgrades the Quick Notes card into a full mini editor: keep multiple notes in tabs, switch any note into a tickable checklist, write in Markdown with a live preview, and roll back to earlier versions from per-note history. Off by default; your existing note is carried over when you turn it on and left untouched if you turn it off.',
                category: 'Productivity',
                keywords: ['notes', 'note', 'todo', 'checklist', 'markdown', 'tabs', 'history', 'tasks', 'memo'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Multiple notes in tabs', 'Checklist mode', 'Live Markdown preview', 'Per-note version history'],
                panelId: 'notes-enhanced-panel',
                panelRenderer: 'renderNotesEnhancedPanel'
            },
            {
                id: 'launchEnhanced',
                label: 'Quick Launch Enhanced',
                icon: 'fa-rocket',
                description: 'Folders, auto-detected games, launch profiles and running-app indicators for Quick Launch.',
                longDescription: 'Supercharges Quick Launch: group apps into folders (Games, Work, or your own), auto-detect installed Steam & Epic games and file them into Games automatically, build launch profiles that open several apps at once, and see at a glance which apps are running. Off by default; your pinned apps are kept exactly as they are.',
                category: 'Utilities',
                keywords: ['launch', 'launcher', 'apps', 'games', 'steam', 'epic', 'folders', 'profiles', 'shortcuts', 'running'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Folders / groups (Games, Work, custom)', 'Auto-detect installed Steam & Epic games', 'Launch profiles — open several apps at once', 'Running-app indicator dots'],
                panelId: 'launch-enhanced-panel',
                panelRenderer: 'renderQuickLaunchEnhancedPanel'
            },
            {
                id: 'gameMode',
                label: 'Game Mode',
                icon: 'fa-gamepad',
                description: 'Detects when a game launches and automatically runs the actions you choose.',
                longDescription: 'Watches the foreground window and notices when a game takes over the screen — either a specific game you name, or any app that goes fullscreen. When it fires, it runs the "profile" you built for that game: mute your mic, show the crosshair, run the FPS optimizer, pop a notification, and switch on any other mini widgets you pick. When the game closes it can undo all of it. Build one profile per game; detection runs quietly in the background while Game Mode is on.',
                category: 'Gaming',
                keywords: ['game', 'gaming', 'fullscreen', 'detect', 'profile', 'automation', 'launch', 'macro', 'trigger', 'rules'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Detects a named game or any fullscreen app', 'Per-game action profiles', 'Mute mic, show crosshair, run FPS optimizer, notify', 'Auto-enable other mini widgets', 'Undo everything when the game closes'],
                panelId: 'game-mode-panel',
                panelRenderer: 'renderGameModePanel'
            },
            {
                id: 'volumeMixer',
                label: 'Volume Mixer',
                icon: 'fa-sliders',
                description: 'Per-app volume sliders and master volume, like the Windows mixer — with hotkeys.',
                longDescription: 'A per-application volume mixer, like the Windows tray mixer: see every app that\'s playing sound and set each one\'s volume or mute it independently, plus control the master output. Optional global hotkeys nudge the master volume up/down or toggle mute from anywhere. Off by default; nothing runs until you switch it on.',
                category: 'Audio',
                keywords: ['volume', 'mixer', 'audio', 'sound', 'per-app', 'master', 'mute', 'loudness', 'speakers'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Per-app volume & mute', 'Master output volume & mute', 'Live session list', 'Global master-volume hotkeys'],
                panelId: 'volume-mixer-panel',
                panelRenderer: 'renderVolumeMixerPanel'
            },
            {
                id: 'discordRpc',
                label: 'Discord Rich Presence',
                icon: 'fa-discord',
                iconStyle: 'fab',
                description: 'Show a fully customizable "playing" status on your Discord profile, with a live preview.',
                longDescription: 'Sets a custom Rich Presence card on your Discord profile — the "Playing …" panel other people see. Fully customizable: details and state lines, large and small images (from your Discord app\'s art assets), up to two link buttons and an elapsed-time clock. A live preview shows exactly how it will look before it goes out. You supply your Discord Application ID; the connection is made directly to your running Discord desktop app. Off by default.',
                category: 'Social',
                keywords: ['discord', 'rich presence', 'rpc', 'status', 'playing', 'profile', 'activity', 'presence'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Custom details, state & images', 'Up to two link buttons', 'Elapsed-time clock', 'Live preview card', 'Connects to your Discord desktop app'],
                panelId: 'discord-rpc-panel',
                panelRenderer: 'renderDiscordRpcPanel'
            }
        ];

        // Canonical category list for the Widget Library filter bar. Categories a
        // registered widget can belong to; the library only shows chips for
        // categories that actually have widgets, so this can list future ones too.
        const MINI_WIDGET_CATEGORIES = [
            'General', 'Gaming', 'Spotify', 'Media', 'Audio', 'Productivity',
            'System', 'Utilities', 'Experimental', 'Networking', 'Weather',
            'Displays', 'Searching', 'Clipboard', 'Social'
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

