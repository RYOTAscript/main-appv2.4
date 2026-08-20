        const APP_VERSION = 'v4.0.1';
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
        //   platforms     optional OS allow-list, e.g. ['win32']. Omit for "all
        //                 platforms". Windows-only widgets carry ['win32'] so
        //                 they're hidden on macOS (see renderer/widget-platform.js).
        //                 The full catalogue lives in MINI_WIDGETS_ALL below; the
        //                 app then derives the OS-filtered MINI_WIDGETS from it.
        const MINI_WIDGETS_ALL = [
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
                platforms: ['win32'], // Win32 SendInput; needs a native input module on macOS
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
                id: 'macMacros',
                platforms: ['darwin'], // macOS Macros — build-and-play (no recording)
                label: 'Macros',
                icon: 'fa-keyboard',
                description: 'Build keyboard & mouse macros and play them back with a hotkey.',
                longDescription: 'A macros tool for macOS. Because macOS doesn’t let apps silently record your input, you build a macro from steps instead of recording one — type text, press a key (with ⌘/⌥/⌃/⇧ modifiers), wait, click at a screen position, or move the pointer — then play it back with a button or a global hotkey. Keyboard-only macros run straight away (you just grant Accessibility permission the first time); macros that click or move the mouse use cliclick, a tiny free tool the widget can install for you in one click. Great for repetitive typing, boilerplate, and multi-step shortcuts.',
                category: 'Productivity',
                keywords: ['macro', 'macros', 'automation', 'keyboard', 'mouse', 'hotkey', 'replay', 'text expander', 'cliclick', 'osascript', 'macos', 'mac', 'keystroke', 'click'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Build macros from steps (type / key / wait / click / move)', 'Play by button or a global hotkey', 'Modifier keys — ⌘ ⌥ ⌃ ⇧', 'Keyboard macros need no install (Accessibility permission)', 'Mouse steps via cliclick (1-click install)', 'Note: live recording isn’t possible on macOS'],
                panelId: 'mac-macros-panel',
                panelRenderer: 'renderMacMacrosPanel'
            },
            {
                id: 'controllerMacros',
                platforms: ['win32'], // ViGEm virtual-gamepad driver is Windows-only
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
                id: 'fullscreenLyrics',
                label: 'Full Screen Lyrics',
                icon: 'fa-up-right-and-down-left-from-center',
                description: 'An Apple Music–style full-screen lyrics stage, opened from a button on the player.',
                longDescription: 'Turns the compact lyrics strip into a cinematic, Apple Music–style full-screen lyrics stage. When on, a small full-screen button appears in the top-left of the Spotify player (only while the Lyrics display is enabled) — click it to fill the whole window with big, bold, karaoke-synced lyrics over a blurred, colour-matched album-art backdrop. The active line lights up and glides to centre as the song plays, past and upcoming lines soften and blur with distance, and every line is click-to-seek when the track has synced timing. Reads beautifully whether the panel has synced lyrics or plain text.',
                category: 'Spotify',
                keywords: ['lyrics', 'fullscreen', 'full screen', 'apple music', 'karaoke', 'spotify', 'music', 'immersive', 'stage', 'sing', 'synced', 'now playing'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Full-screen, Apple Music–style lyrics stage', 'Full-screen button on the player (top-left) while Lyrics are on', 'Karaoke highlight that glides to centre as the song plays', 'Blurred, colour-matched album-art backdrop', 'Progressive dim + blur on past / upcoming lines', 'Click any line to seek (synced tracks)', 'Album-blur or accent-gradient backdrop, centre or left alignment'],
                panelId: 'fullscreen-lyrics-panel',
                panelRenderer: 'renderFullscreenLyricsPanel'
            },
            {
                id: 'screenResolution',
                // Cross-platform: native display APIs on Windows, displayplacer on macOS.
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
                // Cross-platform: WinRT radios on Windows, blueutil on macOS (main/bluetoothMac.js).
                label: 'Bluetooth Manager',
                icon: 'fa-bluetooth-b',
                iconStyle: 'fab',
                description: 'Full Bluetooth control — radio power, connect, pair, battery, favourites & auto-reconnect.',
                longDescription: 'A complete Bluetooth control centre. Turn the Bluetooth radio itself on and off, see every paired device with its live connection status, device type, battery level and when you last used it, and connect / disconnect / remove them. Scan for and pair nearby devices, filter a long list by name, star your favourites so they sort to the top, and switch on Auto-reconnect to have dropped favourites quietly reconnected while the panel is open.',
                category: 'System',
                keywords: ['bluetooth', 'device', 'headphones', 'pair', 'connect', 'wireless', 'battery', 'radio', 'toggle', 'on', 'off', 'auto', 'reconnect', 'favourite', 'adapter'],
                version: '2.0.0',
                author: 'ryota',
                features: ['Turn the Bluetooth radio on / off', 'Connect / disconnect paired devices', 'Device type, battery & last-used time', 'Favourites with optional auto-reconnect', 'Filter devices by name', 'Scan for and pair nearby devices', 'Remove devices'],
                panelId: 'bluetooth-panel',
                panelRenderer: 'renderBluetoothPanel'
            },
            {
                id: 'taskbar',
                platforms: ['win32'], // macOS has no taskbar (menu bar + Dock)
                label: 'Translucent Taskbar',
                icon: 'fa-window-maximize',
                description: 'Make the Windows taskbar transparent, blurred or acrylic — a TranslucentTB-style styler.',
                longDescription: 'Restyle the Windows taskbar like TranslucentTB. Pick an appearance — Clear (see-through), Blur (frosted), Acrylic (tinted acrylic material), Opaque (a solid colour) or Normal (Windows default) — then dial in a tint colour and opacity, with a live mock-taskbar preview. Modern Windows 11 (24H2/25H2) renders the taskbar through a XAML surface the old transparency API can no longer touch, so if you have TranslucentTB installed this widget drives it (writing its live-reloaded settings and launching it), giving you a single in-launcher control panel; it backs up your existing TranslucentTB look and restores it when you turn the widget off. On Windows 10 and older Windows 11 it uses a built-in accent engine instead — no extra install needed. Turning the widget off restores the default taskbar.',
                category: 'System',
                keywords: ['taskbar', 'translucent', 'translucenttb', 'transparent', 'transparency', 'blur', 'acrylic', 'clear', 'glass', 'theme', 'appearance', 'tint', 'opacity', 'shell', 'explorer'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Clear, Blur, Acrylic, Opaque or Normal styles', 'Custom tint colour & opacity', 'Live mock-taskbar preview', 'Drives your installed TranslucentTB on Windows 11 24H2+', 'Backs up & restores your TranslucentTB config', 'Built-in accent engine fallback on Windows 10 / older 11'],
                panelId: 'taskbar-panel',
                panelRenderer: 'renderTaskbarPanel'
            },
            {
                id: 'dockStyler',
                platforms: ['darwin'], // macOS substitute for Translucent Taskbar
                label: 'Dock Styler',
                icon: 'fa-window-maximize',
                description: 'Style the macOS Dock — auto-hide, size, magnification, position, minimize effect and more.',
                longDescription: 'The macOS take on the taskbar styler. macOS has no taskbar, so this styles the Dock — its equivalent row of app icons. Auto-hide it, resize the icons, turn magnification on and set the magnified size, move it to the left, right or bottom, pick the minimize animation (Genie, Scale or Suck), tune the auto-hide speed and delay, make hidden apps’ icons translucent, hide recent apps, minimize windows into their app icon, or show only running apps. Every option is a real macOS setting applied instantly, and one button restores all the Dock defaults. Uses only Apple’s own settings — nothing is installed.',
                category: 'System',
                keywords: ['dock', 'taskbar', 'macos', 'mac', 'autohide', 'magnification', 'size', 'position', 'minimize', 'genie', 'translucent', 'hidden', 'style', 'appearance'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Auto-hide the Dock + tune hide speed & delay', 'Resize icons and set magnification', 'Move the Dock to bottom / left / right', 'Genie / Scale / Suck minimize animation', 'Translucent hidden-app icons', 'Show running apps only / hide recents', 'One-click restore to Dock defaults'],
                panelId: 'dock-styler-panel',
                panelRenderer: 'renderDockStylerPanel'
            },
            {
                id: 'claudeLimit',
                // Cross-platform: reads ~/.claude for the reset (both OSes); send via SendKeys on Windows, osascript on macOS (main/claudeLimitMac.js).
                label: 'Claude Limit Auto-Continue',
                icon: 'fa-robot',
                description: 'Detects a Claude usage limit from Claude Code\'s own session log and auto-continues the chat when it resets.',
                longDescription: 'When you hit a usage limit in Claude (claude.ai), Claude Code, Cursor, Nimbalyst or any chat app, this reads when the limit resets, counts down, and at reset time focuses the chat window you picked and sends a prompt for you — so the conversation continues on its own. Most reliably it detects the limit the way Claude Code / Nimbalyst do — by reading the exact 429 reset time from Claude Code\'s own session transcript (~/.claude), no copying and works even when the window isn\'t focused. It can also read the on-screen banner from a window via Windows UI Automation, read the reset time from a pasted message or your clipboard, or just take a time or a countdown you set. Turn on Auto-detect and it watches for the limit for you. Built for unattended, overnight runs: it keeps the PC awake while armed so it never sleeps through the reset, retries the paste a few times if the window won\'t focus, and can desktop-notify you the moment it fires. For rolling "N-hour limit" windows, turn on Keep continuing and it re-arms itself for each reset — up to a safety cap you set — so a long autonomous session keeps going on its own; a recent-fires log shows exactly what happened while you were away. It resumes only AFTER the limit resets — it never bypasses a limit, it just does the "come back later and continue" step for you.',
                category: 'Productivity',
                keywords: ['claude', 'limit', 'usage', 'credit', 'rate limit', 'reset', 'continue', 'auto', 'cursor', 'nimbalyst', 'claude code', 'wait', 'resume', 'countdown', 'quota', 'anthropic', 'overnight', 'unattended', 'repeat', 'keep awake', 'notification', 'history', 'detect', 'auto-detect', 'banner', 'transcript', '429'],
                version: '2.2.0',
                author: 'ryota',
                features: ['Detects the exact reset time from Claude Code\'s own session log (429 event)', 'Or auto-detects the limit banner inside a window — no copying', 'Also reads the reset time from a pasted message or clipboard', 'Counts down and auto-continues at reset', 'Repeat mode re-arms for each rolling reset (with a safety cap)', 'Keeps the PC awake while armed so it never sleeps through the reset', 'Retries the paste if the window won\'t focus', 'Desktop notification + recent-fires history log', 'Sends your prompt into Cursor / Nimbalyst / Claude web / any window', 'Resumes after reset — never bypasses a limit'],
                panelId: 'claude-limit-panel',
                panelRenderer: 'renderClaudeLimitPanel'
            },
            {
                id: 'fileSearch',
                label: 'File Search',
                icon: 'fa-magnifying-glass',
                description: 'Instant filename search across your folders — like voidtools Everything.',
                longDescription: 'A blazing-fast filename search, in the spirit of voidtools Everything. It builds an in-memory index of the folders you choose (your user folder by default, or add any drives/folders), then answers every keystroke instantly. Search by name with wildcards (*, ?), filter by extension (ext:mp4,png), size (size:>10mb), folders-only or files-only, match the whole path (path:) or use a raw regex — then open the file, open its folder, or copy its path. Rebuild the index any time from the panel; results show size, type and when each file was last modified.',
                category: 'Searching',
                keywords: ['file', 'search', 'find', 'everything', 'voidtools', 'filename', 'explorer', 'index', 'locate', 'regex', 'wildcard', 'ext', 'folder', 'path'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Instant in-memory filename search', 'Index the folders/drives you choose', 'Wildcards, ext:, size:, path:, folder:/file:, regex:', 'Open file, open folder, copy path', 'Sort by name, size or date', 'Shows size, type & last-modified'],
                panelId: 'file-search-panel',
                panelRenderer: 'renderFileSearchPanel'
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
                id: 'valclips',
                label: 'ValClips Quality',
                icon: 'fa-wand-magic-sparkles',
                description: 'Max-quality TikTok exporter for short Valorant edits — survives TikTok\'s re-encode.',
                longDescription: 'A maximum-effort quality tool for ~20-second Valorant edits. Drop a clip and it analyzes it (VFR, HDR, grain, resolution, fps, motion), picks the optimal plan, and either losslessly remuxes an already-perfect file or runs a VMAF-verified x264 encode — true CFR conversion, grain-sparing denoise, HDR tone-mapping, lanczos downscale, blurred-pad framing, and high-motion x264 tuning — so the file looks as close to your editor preview as possible after TikTok compresses it. Every export is VMAF + SSIM verified with auto-retry, and you get a wipe/side-by-side compare viewer at the highest-motion moments plus an upload checklist. Optional Tune panel with live before/after preview. Uses its own bundled FFmpeg toolchain (one-time download with VMAF), kept separate from the rest of the app.',
                category: 'Media',
                keywords: ['valorant', 'tiktok', 'clip', 'quality', 'encode', 'ffmpeg', 'vmaf', 'compress', 'export', 'x264', 'denoise', 'hdr', 'upload', 'edit', 'render', 'crf'],
                version: '1.2.0',
                author: 'ryota',
                features: ['Drop-and-go Express pipeline', 'VMAF + SSIM verified encodes with auto-retry', 'Lossless remux when the source is already perfect', 'VFR→CFR, HDR tone-map, grain-sparing denoise, lanczos downscale', 'High-motion x264 tuning (umh / merange 32 / aq-mode 3)', 'Master (near-lossless) or Smart Compress (smallest visually-lossless)', 'Live before/after Tune preview + motion-hotspot Compare viewer', 'Bundled FFmpeg toolchain (one-time download)'],
                panelId: 'valclips-panel',
                panelRenderer: 'renderValclipsPanel'
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
                // Cross-platform: Win32 foreground watcher on Windows, osascript poll on macOS (main/gameModeMac.js).
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
            },
            {
                id: 'appInstaller',
                platforms: ['win32'], // winget-backed; Mac equivalent would be Homebrew
                label: 'App Installer',
                icon: 'fa-box-open',
                description: 'Tick a bunch of popular apps and install them all silently in one go.',
                longDescription: 'A one-click bulk app installer. Tick the apps you want from a category grid — browsers, messaging, media, imaging, documents, runtimes, security, compression, dev tools and more — then hit one button and they install one after another, silently, with no clicking Next through wizards. Save your picks as a preset (and export it to a file), so after a PC reset you just load the preset and press Get. It uses Windows\' own package manager (winget) under the hood, so every app is downloaded straight from its real publisher and always at the latest version; apps you already have are detected and skipped. A live progress list shows each install as it happens.',
                category: 'Utilities',
                keywords: ['install', 'installer', 'apps', 'winget', 'bulk', 'setup', 'fresh', 'pc', 'silent', 'batch', 'package', 'new computer', 'reinstall', 'preset'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Category grid of popular apps — tick what you want', 'One-click silent install of everything selected', 'Powered by winget — real publishers, latest versions', 'Detects & skips apps you already have', 'Live per-app install progress', 'Great for setting up a fresh Windows install'],
                panelId: 'app-installer-panel',
                panelRenderer: 'renderAppInstallerPanel'
            },
            {
                id: 'appInstallerMac',
                platforms: ['darwin'], // macOS substitute for the winget App Installer
                label: 'App Installer',
                icon: 'fa-box-open',
                description: 'Tick popular Mac apps and install them all with Homebrew in one go.',
                longDescription: 'The macOS take on the bulk app installer. Tick the apps you want from a category grid — browsers, messaging, media, productivity, dev tools, utilities, creative and more — and install them one after another with Homebrew Cask, so each app is downloaded straight from its real publisher and always at the latest version. Apps you already have are detected and skipped, a live progress list shows each install as it happens, and everything is validated against a fixed catalog before anything runs. Needs Homebrew (the standard macOS package manager) — if it isn’t installed, one click opens its official installer for you.',
                category: 'Utilities',
                keywords: ['install', 'installer', 'apps', 'homebrew', 'brew', 'cask', 'bulk', 'setup', 'new mac', 'silent', 'batch', 'package', 'macos'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Category grid of popular Mac apps — tick what you want', 'Installs everything selected via Homebrew Cask', 'Real publishers, latest versions', 'Detects & skips apps you already have', 'Live per-app install progress', '1-click Homebrew install if it’s missing'],
                panelId: 'app-installer-mac-panel',
                panelRenderer: 'renderAppInstallerMacPanel'
            },
            {
                id: 'debloat',
                platforms: ['win32'], // removes Windows AppX packages / HKCU tweaks
                label: 'Windows Debloat',
                icon: 'fa-broom',
                description: 'Uninstall preinstalled Windows bloatware and flip reversible privacy & UX tweaks.',
                longDescription: 'A clean-up tool for a fresh (or cluttered) Windows install. The Remove Apps tab scans which preinstalled Microsoft Store apps are actually on your PC — Xbox, News, Weather, Solitaire, Clipchamp, the Office hub and more — and lets you tick the ones you don\'t want and uninstall them all in one go, with a live progress list. The Tweaks tab is a set of reversible switches for the annoyances: show file extensions, bring back the Windows 10 right-click menu, hide the taskbar Widgets/Chat/search buttons, disable Bing web results in Start, and turn off suggested content and ads. Everything works through Windows\' own built-in tools, only ever touches what you tick, and applies to your user account only — no elevation needed. Every tweak is a genuine on/off you can undo from the panel, and app removals show exactly what happened to each one. Apps you might actually use are flagged before you remove them.',
                category: 'System',
                keywords: ['debloat', 'bloatware', 'uninstall', 'remove', 'appx', 'privacy', 'tweaks', 'clean', 'telemetry', 'ads', 'xbox', 'cortana', 'taskbar', 'context menu', 'fresh install', 'optimize', 'declutter'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Scans and lists only the bloat apps actually installed', 'One-click bulk uninstall with live per-app progress', 'Reversible privacy & UX tweaks (real on/off toggles)', 'Show file extensions, classic Win10 right-click menu', 'Hide taskbar Widgets / Chat / search, disable Bing in Start', 'Turn off suggested content & ads', 'Per-user scope — no admin, nothing system-wide', 'Flags apps you might actually want before removing them'],
                panelId: 'debloat-panel',
                panelRenderer: 'renderDebloatPanel'
            },
            {
                id: 'macTweaks',
                platforms: ['darwin'], // macOS substitute for Windows Debloat (Tweaks tab)
                label: 'macOS Tweaks',
                icon: 'fa-wand-magic-sparkles',
                description: 'Curated, reversible macOS power-user tweaks — Finder, keyboard, screenshots and dialogs.',
                longDescription: 'The macOS take on the Debloat tweaks tab: a curated set of the well-known “macOS defaults” power-user switches, each a genuine on/off you can flip back any time. Finder: show hidden files, path & status bars, all file extensions, folders-on-top, list view and search-current-folder by default, and stop .DS_Store files on network/USB drives. Keyboard: faster key repeat, shorter repeat delay, enable key-repeat over the accent popup, and turn off auto-correct, auto-capitalise and smart quotes/dashes. Screenshots: save as PNG and drop the window shadow. Dialogs: expand Save/Print panels and save new documents to disk instead of iCloud by default. Everything applies to your account only, needs no admin, installs nothing, and uses Apple’s own settings.',
                category: 'System',
                keywords: ['tweaks', 'defaults', 'macos', 'mac', 'finder', 'hidden files', 'key repeat', 'screenshot', 'debloat', 'power user', 'settings', 'dsstore', 'autocorrect', 'customize'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Finder: hidden files, path/status bar, extensions, list view', 'Stop .DS_Store on network & USB drives', 'Faster key repeat + disable press-and-hold', 'Turn off auto-correct / smart quotes / capitalise', 'Screenshots as PNG with no shadow', 'Expand Save/Print dialogs; save to disk not iCloud', 'Every tweak is a real, reversible macOS setting'],
                panelId: 'mac-tweaks-panel',
                panelRenderer: 'renderMacTweaksPanel'
            },
            {
                id: 'revoUninstaller',
                platforms: ['win32'], // Windows registry / winget uninstall model
                label: 'Deep Uninstaller',
                icon: 'fa-trash-can',
                description: 'Fully remove a program in 6 stages — run its uninstaller, then sweep up the leftover files & registry keys.',
                longDescription: 'A Revo-Uninstaller-style deep uninstaller. Pick one installed program from a searchable list, hit Uninstall, and it runs a guided 6-stage wipe: (1) a System Restore point for safety, (2) analyze the program\'s install folder and registry footprint, (3) run the program\'s own uninstaller — silently when the program offers a quiet mode or is an MSI, (4) deep-scan for the leftovers ordinary uninstallers leave behind — the install folder, per-user AppData folders named after the app or its publisher, Start-menu shortcuts and Software registry keys, (5) you review the found leftovers and tick which to remove — nothing is deleted without your say-so, then (6) a summary of everything that happened. Every leftover is re-validated against a fixed allow-list of safe locations before deletion, so it can never touch Windows or files outside the program\'s own footprint. It acts on one program at a time and reports honestly when a step needs admin or a file is locked.',
                category: 'System',
                keywords: ['uninstall', 'uninstaller', 'remove', 'delete', 'program', 'app', 'leftovers', 'revo', 'clean', 'registry', 'residue', 'deep', 'wipe', 'declutter', 'installed'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Searchable list of installed programs', '6-stage guided deep uninstall', 'Runs the program\'s own uninstaller (silent when possible)', 'Scans for leftover files, folders & registry keys', 'You review & tick which leftovers to remove', 'System Restore point before it starts (best-effort)', 'Safety allow-list — never touches Windows or unrelated files', 'Honest per-item reporting'],
                panelId: 'revo-uninstaller-panel',
                panelRenderer: 'renderRevoUninstallerPanel'
            },
            {
                id: 'appUninstaller',
                platforms: ['darwin'], // macOS substitute for the Windows Deep Uninstaller
                label: 'App Uninstaller',
                icon: 'fa-trash-can',
                description: 'Fully remove a Mac app — trash the app and sweep up its leftover files in ~/Library.',
                longDescription: 'The macOS take on the Deep Uninstaller. Dragging an app to the Trash leaves behind caches, preferences, logs and support files scattered across your Library — this cleans those up too. Pick an installed app from a searchable list and it finds the leftovers that belong to it (matched by the app’s bundle identifier across Application Support, Caches, Preferences, Logs, Saved Application State, Containers, HTTP storage, cookies and more), shows each with its size, and lets you tick which to remove. Then it moves the app and everything you picked to the Trash — so nothing is ever permanently deleted and you can put anything back. Apple and system apps are locked out, and every path is re-checked against a fixed allow-list of safe locations before it’s touched, so it can only ever affect the app’s own footprint.',
                category: 'System',
                keywords: ['uninstall', 'uninstaller', 'remove', 'delete', 'app', 'leftovers', 'appcleaner', 'clean', 'library', 'caches', 'preferences', 'residue', 'trash', 'macos', 'mac'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Searchable list of installed apps', 'Finds leftovers by bundle id across ~/Library', 'Shows each leftover with its size — tick what to remove', 'Moves everything to the Trash (fully reversible)', 'Apple / system apps are protected', 'Allow-list guard — only ever touches the app’s own files'],
                panelId: 'app-uninstaller-panel',
                panelRenderer: 'renderAppUninstallerPanel'
            },
            {
                id: 'fpsOptimizer',
                platforms: ['win32'], // Windows registry/powercfg/services tweaks; no macOS equivalent
                label: 'FPS Optimizer',
                icon: 'fa-gauge-high',
                description: 'One-stop game booster: free RAM, kill background apps, and apply power/network tweaks.',
                longDescription: 'A complete in-launcher game booster — the former standalone FPS Optimizer, now a mini widget that matches the rest of the app. Boost tab: one-click Optimize (Ultimate Performance, game CPU priority, standby-RAM purge, temp cleanup, Superfetch off, DNS flush, network + Game Mode tweaks), plus Discord-Only and Kill-Everything cleanups that terminate background apps to free resources while protecting Windows and the launcher itself. Power tab: switch between Ultimate / High / Balanced plans, set game CPU scheduling, and enable HAGS. Memory tab: release standby RAM, clear temp files, toggle Superfetch. Network tab: flush DNS, low-latency tweak, and reset. Battery tab: a one-tap power-saver mode for laptops. Restore tab: undo the tweaks and return Windows to its defaults after gaming. Every action shows live progress and reports which steps succeeded.',
                category: 'Gaming',
                keywords: ['fps', 'optimizer', 'boost', 'game', 'gaming', 'performance', 'ram', 'memory', 'kill', 'background', 'power', 'ultimate', 'network', 'latency', 'dns', 'superfetch', 'hags', 'battery', 'temp', 'clean', 'lag', 'stutter'],
                version: '3.0.0',
                author: 'ryota',
                features: ['One-click Optimize (power, CPU, RAM, temp, network, Game Mode)', 'Kill background apps — Discord-only or nuke — without touching Windows/the launcher', 'Power plans: Ultimate / High / Balanced + game CPU priority + HAGS', 'Memory: release standby RAM, clear temp, toggle Superfetch', 'Network: flush DNS, low-latency tweak, reset', 'Battery Saver mode for laptops', 'Restore everything to Windows defaults', 'Live per-step progress'],
                panelId: 'fps-optimizer-panel',
                panelRenderer: 'renderFpsOptimizerPanel'
            },
            {
                id: 'macFreeUp',
                platforms: ['darwin'], // macOS take on the FPS Optimizer
                label: 'Free Up & Quiet',
                icon: 'fa-gauge-high',
                description: 'Free inactive memory and quit background apps to give games and heavy apps more headroom.',
                longDescription: 'The macOS take on the FPS Optimizer. macOS manages power, scheduling and performance itself — there’s no registry or power-plan to tweak — so this stays light and safe: one tap purges inactive (standby) memory back to the free pool, and a reviewable list lets you gracefully quit the background apps eating RAM before you launch a game or a heavy render. Your foreground app, Finder and the launcher itself are always protected, apps are asked to quit (so unsaved work still prompts you), and nothing is force-killed.',
                category: 'Gaming',
                keywords: ['fps', 'optimize', 'boost', 'memory', 'ram', 'purge', 'free', 'quit', 'background', 'apps', 'performance', 'game', 'gaming', 'macos', 'mac', 'cleanup'],
                version: '1.0.0',
                author: 'ryota',
                features: ['Purge inactive memory back to the free pool', 'Reviewable list of background apps to quit', 'Graceful quit — unsaved work still prompts', 'Foreground app, Finder & launcher always protected', 'No force-kills, no system tweaks'],
                panelId: 'mac-freeup-panel',
                panelRenderer: 'renderMacFreeUpPanel'
            }
        ];

        // The registry the rest of the app actually consumes: MINI_WIDGETS_ALL
        // filtered to the current OS. On Windows this keeps every entry (each is
        // either unmarked or lists 'win32'), so behaviour is unchanged; on macOS
        // the Windows-only widgets drop out everywhere at once. Defaults to
        // 'win32' when the platform can't be read, so the full Windows catalogue
        // is never hidden by accident. widget-platform.js loads before this file.
        const MINI_WIDGETS = (typeof window !== 'undefined' && window.WidgetPlatform)
            ? window.WidgetPlatform.filterWidgetsForPlatform(MINI_WIDGETS_ALL, window.WidgetPlatform.currentPlatform())
            : MINI_WIDGETS_ALL;

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

        // ── First-run onboarding ──────────────────────────────────────────────
        // A brand-new profile has no widget prefs, so the dashboard opens empty
        // ("No widgets enabled yet") — a poor first impression. On the very first
        // launch we seed a small, curated set of safe, zero-config widgets:
        // enabled AND pinned to the dashboard strip, so a new user lands on a
        // populated launcher and can discover the rest via the Widget Library.
        //
        // Deliberately conservative — only widgets that are useful immediately with
        // no account, no permission prompt, and no system-wide side effect (nothing
        // that mutates the OS, records input, or draws an on-screen overlay).
        //
        // Runs once, guarded by the `miniWidgetOnboarded` flag. It never touches a
        // returning user: toggling any widget writes a `false` key (see
        // widget-library.js setMiniWidgetEnabled), so anyone who has ever opened the
        // library has a non-empty `miniWidgetPrefs` and is skipped even before the
        // flag existed (upgrade-safe).
        const FIRST_RUN_MINI_WIDGETS = [
            'launchEnhanced',   // Quick Launch — jump to your apps
            'notesEnhanced',    // Quick Notes — jot things down
            'timer',            // Countdown Timer
            'volumeMixer',      // Per-app volume
            'weatherEnhanced',  // Auto-located weather + forecast
        ];

        // Returns true only when it just seeded a genuinely fresh profile — the
        // caller uses that to show a one-time welcome. Returns false for returning
        // users and on any subsequent launch.
        function seedFirstRunMiniWidgets() {
            try {
                if (localStorage.getItem('miniWidgetOnboarded')) return false;

                const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
                // Empty prefs == genuine first run (never a user who disabled things).
                const freshProfile = Object.keys(prefs).length === 0;
                if (freshProfile) {
                    const valid = FIRST_RUN_MINI_WIDGETS.filter(id => MINI_WIDGETS.some(w => w.id === id));
                    const seeded = {};
                    valid.forEach(id => { seeded[id] = true; });
                    localStorage.setItem('miniWidgetPrefs', JSON.stringify(seeded));

                    // The dashboard strip shows favourites only — pin the same set so
                    // it isn't empty on first open. Only if the user has none yet.
                    const favs = safeParseJSON(localStorage.getItem('miniWidgetFavs'), []);
                    if (!Array.isArray(favs) || favs.length === 0) {
                        localStorage.setItem('miniWidgetFavs', JSON.stringify(valid));
                    }
                }

                localStorage.setItem('miniWidgetOnboarded', '1');
                return freshProfile;
            } catch (e) {
                // Onboarding is best-effort — never let it block boot.
                console.warn('First-run widget seeding skipped', e);
                return false;
            }
        }

        function bumpVersion(current, type) {
            const [major, minor, patch] = current.split('.').map(Number);
            if (type === 'bugfix') return `${major}.${minor}.${patch + 1}`;
            if (type === 'feature') return `${major}.${minor + 1}.0`;
            if (type === 'major') return `${major + 1}.0.0`;
            return current;
        }

