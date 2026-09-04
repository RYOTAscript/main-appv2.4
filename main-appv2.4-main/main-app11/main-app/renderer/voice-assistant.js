        // ── Voice Assistant: the executor + the live vocabulary ──────────────
        //
        // The main process (main/voiceAssistant.js) recognises speech and matches it
        // to a command, then dispatches { commandId, params } here. THIS file is what
        // actually performs the command — deliberately, so that every action goes
        // through the exact same window.electronAPI calls and renderer helpers the UI
        // itself uses. Nothing here duplicates Spotify, launcher, timer or widget
        // logic, and the assistant can therefore do nothing a user clicking around
        // the app couldn't already do.
        //
        // It also supplies the VOCABULARY the recogniser's grammar is built from —
        // the user's own pinned apps, detected games, enabled widgets and saved
        // macros. That is why "launch valorant" works: Valorant is on their launcher,
        // so its name is compiled into the grammar.
        //
        // Every executor returns { ok, message? }. `message` overrides the command's
        // default reply, which is how "what's playing" answers with the actual track
        // and how a failure explains itself instead of failing silently.

        let voiceState = { state: 'hidden', enabled: false, hostReady: false, recognizerName: '', micState: 'unknown' };
        let voiceVocabSent = '';

        function isVoiceAssistantEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.voiceAssistant;
        }

        // ── Vocabulary ───────────────────────────────────────────────────────
        // Names only — never paths in the spoken part. The main process sanitises
        // everything again before it can reach a grammar phrase.
        function buildVoiceVocabulary() {
            const apps = [];
            const seen = new Set();

            // Pinned launcher tiles, which is what most people mean by "launch X".
            //
            // A tile's label is often blank — plenty of people run an icon-only
            // launcher — so the name is not a reliable source on its own. Fall back
            // to the icon file and then the executable, and keep every candidate as
            // an alias so "launch chrome", "launch discord" and "launch update" all
            // reach the same tile. Ordering matters: the icon beats the exe because
            // launchers like Discord ship as "Update.exe".
            if (Array.isArray(pinnedApps)) {
                for (const app of pinnedApps) {
                    if (!app || !app.path) continue;
                    const key = app.path.toLowerCase();
                    if (seen.has(key)) continue;
                    const names = voiceAppNames(app);
                    if (!names.length) continue;   // nothing speakable to call it by
                    seen.add(key);
                    apps.push({ id: app.path, name: names[0], aliases: names.slice(1) });
                }
            }

            // Detected games need no separate source: the Quick Launch scanner merges
            // what it finds straight into pinnedApps, so "play siege" is already
            // covered by the loop above once the user has run a scan.

            // Only widgets the user has actually enabled — offering to open a widget
            // that is switched off would be a command that does nothing.
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            const widgets = MINI_WIDGETS
                .filter(w => prefs[w.id] && w.id !== 'voiceAssistant')
                .map(w => ({ id: w.id, name: w.label }));

            const macros = [];
            if (macrosData && Array.isArray(macrosData.macros)) {
                for (const m of macrosData.macros) {
                    if (m && m.id && m.name) macros.push({ id: m.id, name: m.name });
                }
            }

            // The WHOLE catalogue, for "turn on the <x> widget" — as opposed to
            // `widgets` above, which is only what is already enabled and therefore
            // worth opening.
            const allWidgets = MINI_WIDGETS
                .filter(w => w.id !== 'voiceAssistant')
                .map(w => ({ id: w.id, name: w.label }));

            const routines = getVoiceRoutines().map(r => ({ id: r.id, name: r.name }));

            // Bluetooth devices, audio sessions and playlists are refreshed
            // asynchronously (see refreshVoiceLiveVocabulary) because each costs a
            // real round-trip; the last snapshot is used here.
            // Installed apps join the pinned ones. Pinned tiles were added
            // first and win any name clash: a tile the user chose to pin is a
            // stronger signal about what they mean than a Start Menu entry that
            // happens to share its name.
            for (const a of voiceLiveVocab.installed) {
                const key = String(a.name).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                // { id, name } — buildVocabularyList reads `name`, not `label`,
                // and silently drops an entry with the wrong key.
                apps.push({ id: a.id, name: a.name });
            }

            // The user's own wordings, learned by the training flow. Sent raw —
            // main validates every one against the registry before it can reach
            // a grammar, so a corrupt or hostile file cannot shadow a command.
            let aliases = {};
            try { aliases = JSON.parse(localStorage.getItem('voiceAliases') || '{}'); } catch (e) { aliases = {}; }

            return {
                accent: voiceAccent(),
                apps, widgets, allWidgets, macros, routines, aliases,
                devices: voiceLiveVocab.devices,
                sessions: voiceLiveVocab.sessions,
                playlists: voiceLiveVocab.playlists
            };
        }

        // Every speakable name a pinned tile could go by, best first. The main
        // process sanitises these again before any of them reaches a grammar.
        function voiceAppNames(app) {
            const out = [];
            const add = (raw) => {
                const t = String(raw == null ? '' : raw).replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
                if (!t) return;
                // Keep it comparable to how the grammar will see it.
                const key = t.toLowerCase();
                if (!out.some(v => v.toLowerCase() === key)) out.push(t);
            };
            add(app.name);
            add(app.icon);
            add(String(app.path || '').split(/[\\/]/).pop());
            return out;
        }

        // Bluetooth devices, per-app audio sessions and Spotify playlists change
        // while the app runs and each costs a real round-trip, so they are polled
        // on demand rather than rebuilt inline. Only widgets that are switched on
        // are asked — a disabled widget's IPC would just fail.
        let voiceLiveVocab = { devices: [], sessions: [], playlists: [], installed: [] };

        async function refreshVoiceLiveVocabulary() {
            if (!isVoiceAssistantEnabled()) return;
            const next = { devices: [], sessions: [], playlists: [], installed: [] };
            try {
                if (isMiniWidgetEnabled('bluetooth') && window.electronAPI?.bluetoothList) {
                    const res = await window.electronAPI.bluetoothList();
                    for (const d of (res && res.devices) || []) {
                        if (d && d.name && d.address) next.devices.push({ id: d.address, name: d.name });
                    }
                }
            } catch (e) { /* leave the list empty */ }
            try {
                if (isMiniWidgetEnabled('volumeMixer') && window.electronAPI?.volumeMixerList) {
                    const res = await window.electronAPI.volumeMixerList();
                    for (const s of (res && res.sessions) || []) {
                        if (s && s.name && s.pid) next.sessions.push({ id: String(s.pid), name: s.name });
                    }
                }
            } catch (e) { /* leave the list empty */ }
            try {
                if (window.electronAPI?.spotifyGetPlaylists) {
                    const res = await window.electronAPI.spotifyGetPlaylists();
                    for (const p of (res && res.items) || []) {
                        if (p && p.name && p.uri) next.playlists.push({ id: p.uri, name: p.name });
                    }
                }
            } catch (e) { /* Spotify may simply not be connected */ }


            try {
                // Everything installed, from the Start Menu. Without this the
                // assistant could only launch apps the user had PINNED — every
                // other program was not a word it knew, so "open OBS" was
                // inaudible rather than misheard.
                if (window.electronAPI?.appIndexList) {
                    const list = await window.electronAPI.appIndexList();
                    for (const a of list || []) {
                        if (a && a.id && a.label) next.installed.push({ id: a.id, name: a.label });
                    }
                }
            } catch (e) { /* pinned tiles still work on their own */ }

            const changed = JSON.stringify(next) !== JSON.stringify(voiceLiveVocab);
            voiceLiveVocab = next;
            // Rebuilding the grammar STOPS recognition in the host, so doing it
            // every time an app opens or closes an audio session made the
            // assistant stutter. Only rebuild when the list genuinely changed,
            // and never while it is mid-listen.
            if (changed && !voiceIsBusy()) await pushVoiceVocabulary(true);
        }

        // True while the assistant is actually working, so background refreshes
        // can keep out of the way.
        function voiceIsBusy() {
            const st = (voiceState && voiceState.state) || 'hidden';
            return st !== 'hidden' && st !== 'idle';
        }

        // The launcher's accent theme, as bare "r,g,b". Defaults to white, which
        // is what --accent is until the user picks a theme — so the overlay is
        // white out of the box and adopts their colour the moment they set one.
        function voiceAccent() {
            try {
                const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
                const m = v.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
                return m ? m[1] + ',' + m[2] + ',' + m[3] : '255,255,255';
            } catch (e) {
                return '255,255,255';
            }
        }

        async function pushVoiceVocabulary(force) {
            if (!window.electronAPI?.voiceSetVocabulary) return;
            if (!isVoiceAssistantEnabled()) return;
            const vocab = buildVoiceVocabulary();
            const signature = JSON.stringify(vocab);
            // The vocabulary is rebuilt on every widget toggle and pinned-app edit;
            // re-sending an identical list would rebuild the grammar for nothing.
            if (!force && signature === voiceVocabSent) return;
            voiceVocabSent = signature;
            try {
                await window.electronAPI.voiceSetVocabulary(vocab);
            } catch (e) {
                console.warn('Voice vocabulary could not be sent', e);
            }
        }

        // ── Small helpers shared by the executors ────────────────────────────
        function voiceFindApp(pathOrUri) {
            if (!Array.isArray(pinnedApps)) return null;
            return pinnedApps.find(a => a && a.path === pathOrUri) || null;
        }

        async function voiceNudgeSpotifyVolume(delta) {
            if (!window.electronAPI?.spotifyGetCurrentTrack || !window.electronAPI?.spotifySetVolume) {
                return { ok: false, message: 'Spotify isn’t connected' };
            }
            const data = await window.electronAPI.spotifyGetCurrentTrack();
            if (!data || !data.connected) return { ok: false, message: 'Spotify isn’t connected' };
            // The device's own volume, which is what spotifySetVolume writes back.
            const current = typeof data.volume_percent === 'number' ? data.volume_percent : null;
            if (current === null) return { ok: false, message: 'No active Spotify device' };
            const next = Math.max(0, Math.min(100, current + delta));
            await window.electronAPI.spotifySetVolume(next);
            return { ok: true, message: `Volume ${next}%` };
        }

        // Opens the Widget Library focused on a widget — the app's own navigation,
        // not a bespoke voice-only surface.
        async function voiceOpenWidget(id, label) {
            if (typeof openWidgetLibrary !== 'function') return { ok: false, message: 'Can’t open that here' };
            await focusLauncherWindow();
            openWidgetLibrary(id);
            return { ok: true, message: `Opening ${label || 'widget'}` };
        }

        // Commands that show UI are useless if the launcher is behind a game or
        // minimised to tray. window.focus() from a renderer cannot fix either —
        // only the main process can restore and raise a BrowserWindow, so this
        // asks it to. (This is what made "open settings" look broken: the modal
        // opened correctly, out of sight.)
        // Must be AWAITED before opening anything. While the launcher is occluded
        // Chromium freezes its CSS animations — the settings overlay would sit at
        // opacity 0 with its fade-in stuck at currentTime 0, looking for all the
        // world like the command did nothing. Raising the window first lets the
        // animation actually run.
        async function focusLauncherWindow() {
            if (window.electronAPI?.voiceFocusLauncher) {
                try { await window.electronAPI.voiceFocusLauncher(); } catch (e) { /* fall through */ }
                // One frame for the compositor to start painting again.
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                return;
            }
            try { window.focus(); } catch (e) { /* nothing else to try */ }
        }


        // ── Helpers the expanded command set shares ──────────────────────────
        async function voiceNudgeMaster(delta) {
            if (!window.electronAPI?.volumeMixerList || !window.electronAPI?.volumeMixerSetMaster) {
                return { ok: false, message: 'Volume Mixer isn’t available' };
            }
            if (!isMiniWidgetEnabled('volumeMixer')) return { ok: false, message: 'Volume Mixer widget is off' };
            const data = await window.electronAPI.volumeMixerList();
            const current = data && data.master && typeof data.master.volume === 'number' ? data.master.volume : -1;
            if (current < 0) return { ok: false, message: 'Couldn’t read the volume' };
            const next = Math.max(0, Math.min(100, current + delta));
            await window.electronAPI.volumeMixerSetMaster(next);
            return { ok: true, message: `Volume ${next}%` };
        }

        async function voiceMuteSession(params, mute) {
            if (!window.electronAPI?.volumeMixerMuteApp) return { ok: false, message: 'Volume Mixer isn’t available' };
            if (!isMiniWidgetEnabled('volumeMixer')) return { ok: false, message: 'Volume Mixer widget is off' };
            const pid = parseInt(params && params.session, 10);
            if (!pid) return { ok: false, message: 'Which app?' };
            await window.electronAPI.volumeMixerMuteApp(pid, mute);
            return { ok: true, message: `${mute ? 'Muted' : 'Unmuted'} ${params.sessionLabel || 'it'}` };
        }

        async function voiceSetRadio(state) {
            if (!window.electronAPI?.bluetoothRadioSet) return { ok: false, message: 'Bluetooth isn’t available' };
            if (!isMiniWidgetEnabled('bluetooth')) return { ok: false, message: 'Bluetooth widget is off' };
            const res = await window.electronAPI.bluetoothRadioSet(state);
            if (res && res.ok === false) return { ok: false, message: 'Couldn’t change the radio' };
            return { ok: true, message: `Bluetooth ${state}` };
        }

        // Every granular performance tweak goes through the one fps-action channel,
        // which validates the key against its own ACTIONS table.
        async function voiceFpsAction(key) {
            if (!window.electronAPI?.fpsAction) return { ok: false, message: 'FPS Optimizer isn’t available' };
            const res = await window.electronAPI.fpsAction(key);
            if (res && res.success === false) return { ok: false, message: 'That tweak didn’t apply' };
            return { ok: true };
        }

        async function voiceSetWidgetBacked(widgetId, apiName, value, okMessage) {
            const fn = window.electronAPI && window.electronAPI[apiName];
            if (typeof fn !== 'function') return { ok: false, message: 'Not available' };
            if (!isMiniWidgetEnabled(widgetId)) return { ok: false, message: 'That widget is off' };
            await fn(value);
            return { ok: true, message: okMessage };
        }

        function voiceTimerCall(fnName, okMessage) {
            const fn = window[fnName];
            if (typeof fn !== 'function') return { ok: false, message: 'Timer isn’t available' };
            if (!isMiniWidgetEnabled('timer')) return { ok: false, message: 'Countdown Timer widget is off' };
            fn();
            return { ok: true, message: okMessage };
        }

        async function voiceSetAutostart(on) {
            if (!window.electronAPI?.setAutoStart) return { ok: false, message: 'Not available' };
            await window.electronAPI.setAutoStart(on);
            const box = document.getElementById('autostart');
            if (box) box.checked = on;
            return { ok: true, message: on ? 'Will start with Windows' : 'Autostart off' };
        }

        // Turning a widget on/off by voice goes through the Widget Library's own
        // setter, so prefs, the dashboard strip and every backend toggle stay in
        // step exactly as if it had been clicked.
        async function voiceToggleWidget(params, on) {
            const id = params && params.anyWidget;
            if (!id) return { ok: false, message: 'Which widget?' };
            if (id === 'voiceAssistant') {
                return on
                    ? { ok: true, message: 'Already on' }
                    : { ok: false, message: 'Turn me off in the Widget Library' };
            }
            if (typeof setMiniWidgetEnabled !== 'function') return { ok: false, message: 'Can’t do that here' };
            await setMiniWidgetEnabled(id, on);
            return { ok: true, message: `${params.anyWidgetLabel || 'Widget'} ${on ? 'on' : 'off'}` };
        }

        // ── Routines ─────────────────────────────────────────────────────────
        // Stored in localStorage next to every other widget preference.
        // { id, name, steps: [ "next track", "optimize my pc" ] }
        function getVoiceRoutines() {
            const raw = safeParseJSON(localStorage.getItem('voiceRoutines'), []);
            return Array.isArray(raw) ? raw.filter(r => r && r.id && r.name) : [];
        }

        function saveVoiceRoutines(list) {
            localStorage.setItem('voiceRoutines', JSON.stringify(list));
            scheduleSettingsSave();
            pushVoiceVocabulary(true);
        }

        function voiceFindRoutine(id) {
            return getVoiceRoutines().find(r => r.id === id) || null;
        }

        // Resolves one routine step to a command. Steps are stored as the words the
        // user would say, and they are resolved by the SAME matcher speech goes
        // through (main/voiceCommands.js, reached over voice:match) — so a routine
        // step can never reach a capability a spoken command couldn't, and the
        // panel can tell the user immediately whether a step is understood.
        async function voiceMatchStep(text) {
            if (!window.electronAPI?.voiceMatchText) return null;
            try {
                const m = await window.electronAPI.voiceMatchText(text);
                return (m && m.status === 'matched') ? m : null;
            } catch (e) {
                return null;
            }
        }

        // ── The command table ────────────────────────────────────────────────
        // One arm per registry command in main/voiceCommands.js. Anything missing
        // here is reported honestly rather than silently succeeding.
        const VOICE_EXECUTORS = {
            // ── Spotify ──
            'spotify.play': async () => {
                if (!window.electronAPI?.spotifyControl) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifyControl('play');
                return { ok: true };
            },
            'spotify.pause': async () => {
                if (!window.electronAPI?.spotifyControl) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifyControl('pause');
                return { ok: true };
            },
            'spotify.next': async () => {
                if (!window.electronAPI?.spotifyControl) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifyControl('next');
                return { ok: true };
            },
            'spotify.previous': async () => {
                if (!window.electronAPI?.spotifyControl) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifyControl('previous');
                return { ok: true };
            },
            'spotify.volumeUp': () => voiceNudgeSpotifyVolume(10),
            'spotify.volumeDown': () => voiceNudgeSpotifyVolume(-10),
            'spotify.setVolume': async (params) => {
                if (!window.electronAPI?.spotifySetVolume) return { ok: false, message: 'Spotify isn’t connected' };
                const value = Math.max(0, Math.min(100, parseInt(params.volume, 10) || 0));
                await window.electronAPI.spotifySetVolume(value);
                return { ok: true, message: `Volume ${value}%` };
            },
            'spotify.like': async () => {
                if (!window.electronAPI?.spotifySetSaved) return { ok: false, message: 'Spotify isn’t connected' };
                const track = (typeof spotifyCurrentTrack !== 'undefined') ? spotifyCurrentTrack : null;
                if (!track || !track.id) return { ok: false, message: 'Nothing is playing' };
                const res = await window.electronAPI.spotifySetSaved(track.id, true);
                if (res && res.success === false) return { ok: false, message: 'Couldn’t save that track' };
                return { ok: true, message: `Saved ${track.name || 'track'}` };
            },
            'spotify.whatsPlaying': async () => {
                if (!window.electronAPI?.spotifyGetCurrentTrack) return { ok: false, message: 'Spotify isn’t connected' };
                const data = await window.electronAPI.spotifyGetCurrentTrack();
                if (!data || !data.connected) return { ok: false, message: 'Spotify isn’t connected' };
                const track = data.track;
                if (!track || !track.name) return { ok: false, message: 'Nothing is playing' };
                // main/spotify.js already joins the artist list into a string.
                // Spoken as a sentence, shown as the track — asking "what is
                // playing" wants the title big, not a dash-joined line of grey.
                return {
                    ok: true,
                    answer: {
                        speech: track.artist ? `${track.name}, by ${track.artist}` : track.name,
                        headline: track.name,
                        detail: track.artist || '',
                        meta: track.album && track.album !== track.name ? [track.album] : [],
                        art: track.image || ''
                    }
                };
            },

            // ── System audio & microphone ──
            'system.mute': async () => {
                if (!window.electronAPI?.volumeMixerMuteMaster) return { ok: false, message: 'Volume Mixer isn’t available' };
                await window.electronAPI.volumeMixerMuteMaster(true);
                return { ok: true };
            },
            'system.unmute': async () => {
                if (!window.electronAPI?.volumeMixerMuteMaster) return { ok: false, message: 'Volume Mixer isn’t available' };
                await window.electronAPI.volumeMixerMuteMaster(false);
                return { ok: true };
            },
            'mic.mute': async () => {
                if (!window.electronAPI?.getMicMuteStatus) return { ok: false, message: 'Mic Mute isn’t available' };
                const muted = await window.electronAPI.getMicMuteStatus();
                if (muted === true) return { ok: true, message: 'Already muted' };
                await window.electronAPI.micMuteToggle();
                return { ok: true };
            },
            'mic.unmute': async () => {
                if (!window.electronAPI?.getMicMuteStatus) return { ok: false, message: 'Mic Mute isn’t available' };
                const muted = await window.electronAPI.getMicMuteStatus();
                if (muted !== true) return { ok: true, message: 'Already live' };
                await window.electronAPI.micMuteToggle();
                return { ok: true };
            },

            // ── Launching ──
            'app.launch': async (params) => {
                const target = params && params.app;
                const label = (params && params.appLabel) || 'it';
                if (!target) return { ok: false, message: 'I don’t know that app' };
                // Store/launcher entries are URIs (steam://…), everything else is a path.
                if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
                    if (!window.electronAPI?.quickLaunchLaunchUri) return { ok: false, message: 'Can’t launch that' };
                    const res = await window.electronAPI.quickLaunchLaunchUri(target);
                    if (res && res.success === false) return { ok: false, message: `Couldn’t open ${label}` };
                    return { ok: true, message: `Opening ${label}` };
                }
                if (!window.electronAPI?.launchApp) return { ok: false, message: 'Can’t launch that' };
                const known = voiceFindApp(target);
                const res = await window.electronAPI.launchApp(target, known && known.args ? { args: known.args } : {});
                if (res && res.success === false) {
                    return { ok: false, message: `Couldn’t open ${label}` };
                }
                return { ok: true, message: `Opening ${label}` };
            },

            // ── Performance ──
            'fps.optimize': async () => {
                if (!window.electronAPI?.fpsOptimizeOnly) return { ok: false, message: 'FPS Optimizer isn’t available' };
                const res = await window.electronAPI.fpsOptimizeOnly();
                if (res && res.success === false) return { ok: false, message: 'Some tweaks didn’t apply' };
                return { ok: true };
            },
            'fps.nuke': async () => {
                if (!window.electronAPI?.fpsNuke) return { ok: false, message: 'FPS Optimizer isn’t available' };
                const res = await window.electronAPI.fpsNuke();
                if (res && res.success === false) return { ok: false, message: 'Some apps couldn’t be closed' };
                return { ok: true };
            },
            'fps.battery': async () => {
                if (!window.electronAPI?.fpsBatterySaver) return { ok: false, message: 'FPS Optimizer isn’t available' };
                await window.electronAPI.fpsBatterySaver();
                return { ok: true };
            },
            'fps.revert': async () => {
                if (!window.electronAPI?.fpsRevertOptimizations) return { ok: false, message: 'FPS Optimizer isn’t available' };
                await window.electronAPI.fpsRevertOptimizations();
                return { ok: true };
            },

            // ── Crosshair ──
            'crosshair.show': () => {
                if (typeof chSetVisible !== 'function') return { ok: false, message: 'Crosshair isn’t available' };
                if (!isCrosshairWidgetEnabled()) return { ok: false, message: 'Crosshair widget is off' };
                chSetVisible(true);
                return { ok: true };
            },
            'crosshair.hide': () => {
                if (typeof chSetVisible !== 'function') return { ok: false, message: 'Crosshair isn’t available' };
                if (!isCrosshairWidgetEnabled()) return { ok: false, message: 'Crosshair widget is off' };
                chSetVisible(false);
                return { ok: true };
            },

            // ── Navigation ──
            'widget.open': (params) => voiceOpenWidget(params && params.widget, params && params.widgetLabel),
            'app.openWidgetLibrary': async () => {
                if (typeof openWidgetLibrary !== 'function') return { ok: false, message: 'Can’t open that here' };
                await focusLauncherWindow();
                openWidgetLibrary();
                return { ok: true };
            },
            'app.openSettings': async () => {
                if (typeof openSettings !== 'function') return { ok: false, message: 'Can’t open settings' };
                await focusLauncherWindow();
                // Do NOT unhide the modal here. openSettings() calls
                // cancelModalClose() FIRST and then removes `hidden` — and
                // ui-utils.js says so explicitly: "Open paths must call this
                // first". Removing the class ahead of it skipped that step and
                // left the modal at opacity 0 with its fade-in stalled, which is
                // what made "open settings" look like it did nothing.
                try {
                    await openSettings();
                } catch (e) {
                    console.error('Voice: openSettings failed', e);
                    return { ok: false, message: 'Settings couldn’t open' };
                }
                return { ok: true };
            },
            'app.focus': async () => { await focusLauncherWindow(); return { ok: true }; },

            // ── Search ──
            'search.files': async (params) => {
                const query = String((params && params.query) || '').trim();
                if (!query) return { ok: false, message: 'Search for what?' };
                if (!isMiniWidgetEnabled('fileSearch')) return { ok: false, message: 'File Search widget is off' };
                await focusLauncherWindow();
                if (typeof openWidgetLibrary === 'function') openWidgetLibrary('fileSearch');
                // Pre-fill rather than search blind: this is the one command whose
                // words come from free dictation, which is far less accurate than the
                // closed grammar, so the user sees and confirms the query.
                setTimeout(() => {
                    const input = document.getElementById('fs-input');
                    if (!input) return;
                    input.value = query;
                    // Go through the widget's own input handler rather than firing a
                    // synthetic event — that is the function the widget debounces and
                    // runs its query from.
                    if (typeof fsOnInput === 'function') fsOnInput(query);
                    try { input.focus(); } catch (e) { /* panel still opening */ }
                }, 260);
                return { ok: true, message: `Searching for “${query}”` };
            },

            // ── Information ──
            'weather.now': async () => {
                if (!window.electronAPI?.getWeather) return { ok: false, message: 'Weather isn’t available' };
                const data = await window.electronAPI.getWeather();
                if (!data || (data.temp_C === undefined && data.temp_F === undefined)) {
                    return { ok: false, message: 'Couldn’t get the weather' };
                }
                // Same unit preference the clock/weather widget uses.
                const unit = localStorage.getItem('weatherUnit') || 'C';
                const temp = Math.round(unit === 'F' ? data.temp_F : data.temp_C);
                const feels = data.feelsLike_C !== undefined || data.feelsLike_F !== undefined
                    ? Math.round(unit === 'F' ? data.feelsLike_F : data.feelsLike_C) : null;
                const cond = data.condition ? String(data.condition) : '';
                // Spoken as a sentence, shown as a value — the same string cannot
                // do both well. "twenty-one degrees and clear in London" is what a
                // person says; "21°" is what a person wants to look at.
                const spokenCity = data.city ? ` in ${data.city}` : '';
                const spokenCond = cond ? ` and ${cond.toLowerCase()}` : '';
                return {
                    ok: true,
                    answer: {
                        speech: `It's ${temp} degrees${spokenCond}${spokenCity}`,
                        headline: `${temp}°${unit}`,
                        detail: [cond, data.city].filter(Boolean).join(' · '),
                        meta: [feels !== null && feels !== temp ? `Feels ${feels}°` : ''].filter(Boolean)
                    }
                };
            },
            'system.battery': async () => {
                if (!window.electronAPI?.getSystemExtra) return { ok: false, message: 'Battery info isn’t available' };
                const x = await window.electronAPI.getSystemExtra();
                // A desktop has no battery, and that is an answer rather than a
                // failure — saying "couldn't read it" would be simply wrong.
                if (!x || !x.battery) return { ok: false, message: 'This machine doesn’t have a battery' };
                const b = x.battery;
                const pct = Math.round(b.percent);
                const state = b.charging ? 'charging' : 'on battery';
                const left = !b.charging && b.minutesLeft
                    ? `${Math.floor(b.minutesLeft / 60)}h ${b.minutesLeft % 60}m left` : '';
                return {
                    ok: true,
                    answer: {
                        speech: `Battery is at ${pct} percent and ${state}`,
                        headline: pct + '%',
                        detail: b.charging ? 'Charging' : 'On battery',
                        meta: [left].filter(Boolean)
                    }
                };
            },
            'system.disk': async () => {
                if (!window.electronAPI?.getSystemExtra) return { ok: false, message: 'Disk info isn’t available' };
                const x = await window.electronAPI.getSystemExtra();
                if (!x || !x.disk) return { ok: false, message: 'Couldn’t read your disk' };
                const free = x.disk.freeGb;
                const total = x.disk.totalGb;
                const pct = total ? Math.round((free / total) * 100) : 0;
                // Below a tenth free is worth saying out loud rather than making
                // the user work it out from two numbers.
                const tight = pct <= 10;
                return {
                    ok: true,
                    answer: {
                        speech: tight
                            ? `Only ${free} gigabytes free — that is getting tight`
                            : `${free} gigabytes free of ${total}`,
                        headline: free + ' GB',
                        detail: tight ? 'Running low · C:' : 'Free on C:',
                        meta: [pct + '% free', total + ' GB total']
                    }
                };
            },
            'system.stats': async () => {
                if (!window.electronAPI?.getSystemStats) return { ok: false, message: 'System stats aren’t available' };
                const stats = await window.electronAPI.getSystemStats();
                if (!stats) return { ok: false, message: 'Couldn’t read system stats' };
                const cpu = Math.round(stats.cpu);
                const ram = Math.round(stats.ram);
                // A verdict is more useful than two numbers: the point of asking
                // "how is my PC doing" is the judgement, not the telemetry.
                const worst = Math.max(cpu, ram);
                const verdict = worst < 50 ? 'Running comfortably'
                    : worst < 80 ? 'Working but fine'
                    : 'Under real load';
                return {
                    ok: true,
                    answer: {
                        speech: `${verdict} — CPU at ${cpu} percent, memory at ${ram}`,
                        headline: `${cpu}%`,
                        detail: `${verdict} · CPU`,
                        meta: [`RAM ${ram}%`]
                    }
                };
            },

            // ── Productivity ──
            'timer.start': (params) => {
                if (typeof timerStart !== 'function') return { ok: false, message: 'Timer isn’t available' };
                if (!isMiniWidgetEnabled('timer')) return { ok: false, message: 'Countdown Timer widget is off' };
                const minutes = Math.max(1, Math.min(600, parseInt(params.minutes, 10) || 0));
                timerStart(minutes * 60 * 1000);
                return { ok: true, message: `Timer set for ${minutes} min` };
            },
            'timer.cancel': () => {
                if (typeof timerReset !== 'function') return { ok: false, message: 'Timer isn’t available' };
                timerReset();
                return { ok: true };
            },
            'clipboard.open': () => {
                if (!isMiniWidgetEnabled('clipboard')) return { ok: false, message: 'Clipboard History widget is off' };
                return voiceOpenWidget('clipboard', 'Clipboard History');
            },
            'macro.play': async (params) => {
                if (!window.electronAPI?.macrosPlay) return { ok: false, message: 'Macros aren’t available' };
                if (!isMiniWidgetEnabled('macros')) return { ok: false, message: 'Macros widget is off' };
                const id = params && params.macro;
                if (!id) return { ok: false, message: 'Which macro?' };
                const res = await window.electronAPI.macrosPlay(id);
                if (res && res.success === false) return { ok: false, message: 'That macro couldn’t run' };
                return { ok: true, message: `Running ${(params && params.macroLabel) || 'macro'}` };
            },

            // ── Spotify, deeper ──
            'spotify.playPlaylist': async (params) => {
                if (!window.electronAPI?.spotifyPlayContext) return { ok: false, message: 'Spotify isn’t connected' };
                if (!params.playlist) return { ok: false, message: 'Which playlist?' };
                const res = await window.electronAPI.spotifyPlayContext(params.playlist);
                if (res && res.success === false) return { ok: false, message: 'Couldn’t start that playlist' };
                return { ok: true, message: `Playing ${params.playlistLabel || 'playlist'}` };
            },
            'spotify.unlike': async () => {
                if (!window.electronAPI?.spotifySetSaved) return { ok: false, message: 'Spotify isn’t connected' };
                const track = (typeof spotifyCurrentTrack !== 'undefined') ? spotifyCurrentTrack : null;
                if (!track || !track.id) return { ok: false, message: 'Nothing is playing' };
                await window.electronAPI.spotifySetSaved(track.id, false);
                return { ok: true };
            },
            'spotify.restart': async () => {
                if (!window.electronAPI?.spotifySeek) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifySeek(0);
                return { ok: true };
            },
            'spotify.mute': async () => {
                if (!window.electronAPI?.spotifySetVolume) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifySetVolume(0);
                return { ok: true };
            },
            'spotify.full': async () => {
                if (!window.electronAPI?.spotifySetVolume) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.spotifySetVolume(100);
                return { ok: true };
            },
            'spotify.queue': async () => {
                if (!window.electronAPI?.spotifyGetQueue) return { ok: false, message: 'Spotify isn’t connected' };
                const res = await window.electronAPI.spotifyGetQueue();
                const next = res && Array.isArray(res.items) ? res.items[0] : null;
                if (!next || !next.name) return { ok: false, message: 'Nothing queued' };
                return { ok: true, message: `Next: ${next.name}${next.artist ? ' — ' + next.artist : ''}` };
            },
            'spotify.sleepTimer': async (params) => {
                if (!window.electronAPI?.startSpotifySleepTimer) return { ok: false, message: 'Spotify isn’t connected' };
                const mins = Math.max(1, Math.min(600, parseInt(params.minutes, 10) || 0));
                await window.electronAPI.startSpotifySleepTimer(mins);
                return { ok: true, message: `Music stops in ${mins} min` };
            },
            'spotify.sleepCancel': async () => {
                if (!window.electronAPI?.cancelSpotifySleepTimer) return { ok: false, message: 'Spotify isn’t connected' };
                await window.electronAPI.cancelSpotifySleepTimer();
                return { ok: true };
            },

            // ── System volume (the Volume Mixer engine) ──
            'system.volumeUp': () => voiceNudgeMaster(10),
            'system.volumeDown': () => voiceNudgeMaster(-10),
            'system.setVolume': async (params) => {
                if (!window.electronAPI?.volumeMixerSetMaster) return { ok: false, message: 'Volume Mixer isn’t available' };
                if (!isMiniWidgetEnabled('volumeMixer')) return { ok: false, message: 'Volume Mixer widget is off' };
                const v = Math.max(0, Math.min(100, parseInt(params.volume, 10) || 0));
                await window.electronAPI.volumeMixerSetMaster(v);
                return { ok: true, message: `System volume ${v}%` };
            },
            'app.mute': (params) => voiceMuteSession(params, true),
            'app.unmute': (params) => voiceMuteSession(params, false),
            'mic.toggle': async () => {
                if (!window.electronAPI?.micMuteToggle) return { ok: false, message: 'Mic Mute isn’t available' };
                const muted = await window.electronAPI.micMuteToggle();
                return { ok: true, message: muted ? 'Microphone muted' : 'Microphone live' };
            },

            // ── Bluetooth ──
            'bluetooth.on': () => voiceSetRadio('on'),
            'bluetooth.off': () => voiceSetRadio('off'),
            'bluetooth.connect': async (params) => {
                if (!window.electronAPI?.bluetoothConnect) return { ok: false, message: 'Bluetooth isn’t available' };
                if (!isMiniWidgetEnabled('bluetooth')) return { ok: false, message: 'Bluetooth widget is off' };
                if (!params.device) return { ok: false, message: 'Connect to what?' };
                const res = await window.electronAPI.bluetoothConnect(params.device);
                if (res && res.ok === false) return { ok: false, message: `Couldn’t connect ${params.deviceLabel || 'it'}` };
                return { ok: true, message: `Connected ${params.deviceLabel || 'device'}` };
            },
            'bluetooth.disconnect': async (params) => {
                if (!window.electronAPI?.bluetoothDisconnect) return { ok: false, message: 'Bluetooth isn’t available' };
                if (!params.device) return { ok: false, message: 'Disconnect what?' };
                const res = await window.electronAPI.bluetoothDisconnect(params.device);
                if (res && res.ok === false) return { ok: false, message: 'Couldn’t disconnect it' };
                return { ok: true, message: `Disconnected ${params.deviceLabel || 'device'}` };
            },

            // ── Performance, granular (main/fpsOptimizer.js ACTIONS) ──
            'fps.ultimate': () => voiceFpsAction('ultimate'),
            'fps.high': () => voiceFpsAction('high'),
            'fps.balanced': () => voiceFpsAction('balanced'),
            'fps.clearStandby': () => voiceFpsAction('clearStandby'),
            'fps.clearTemp': () => voiceFpsAction('clearTemp'),
            'fps.flushDns': () => voiceFpsAction('flushDns'),
            'fps.lowLatency': () => voiceFpsAction('lowLatency'),
            'fps.cpuPriority': () => voiceFpsAction('cpuPriority'),
            'fps.hags': () => voiceFpsAction('hags'),

            // ── Crosshair ──
            'crosshair.toggle': () => {
                if (typeof chSetVisible !== 'function') return { ok: false, message: 'Crosshair isn’t available' };
                if (!isCrosshairWidgetEnabled()) return { ok: false, message: 'Crosshair widget is off' };
                const next = !isCrosshairVisible();
                chSetVisible(next);
                return { ok: true, message: next ? 'Crosshair on' : 'Crosshair off' };
            },
            'crosshair.style': (params) => {
                if (typeof chSetOption !== 'function') return { ok: false, message: 'Crosshair isn’t available' };
                if (!isCrosshairWidgetEnabled()) return { ok: false, message: 'Crosshair widget is off' };
                if (!params.crosshairStyle) return { ok: false, message: 'Which style?' };
                chSetOption('style', params.crosshairStyle);
                return { ok: true, message: `Crosshair: ${params.crosshairStyleLabel}` };
            },
            'crosshair.color': (params) => {
                if (typeof chSetOption !== 'function') return { ok: false, message: 'Crosshair isn’t available' };
                if (!isCrosshairWidgetEnabled()) return { ok: false, message: 'Crosshair widget is off' };
                if (!params.colour) return { ok: false, message: 'Which colour?' };
                chSetOption('color', params.colour);
                return { ok: true, message: `Crosshair ${params.colourLabel}` };
            },

            // ── Gaming utilities ──
            'gameMode.on': () => voiceSetWidgetBacked('gameMode', 'gameModeSetEnabled', true, 'Game Mode on'),
            'gameMode.off': () => voiceSetWidgetBacked('gameMode', 'gameModeSetEnabled', false, 'Game Mode off'),
            'autoClicker.start': async () => {
                if (!window.electronAPI?.autoClickerStart) return { ok: false, message: 'Auto Clicker isn’t available' };
                if (!isMiniWidgetEnabled('autoClicker')) return { ok: false, message: 'Auto Clicker widget is off' };
                const res = await window.electronAPI.autoClickerStart();
                if (res && res.ok === false) return { ok: false, message: 'Auto clicker couldn’t start' };
                return { ok: true };
            },
            'autoClicker.stop': async () => {
                if (!window.electronAPI?.autoClickerStop) return { ok: false, message: 'Auto Clicker isn’t available' };
                await window.electronAPI.autoClickerStop();
                return { ok: true };
            },
            'macro.stop': async () => {
                if (!window.electronAPI?.macrosStop) return { ok: false, message: 'Macros aren’t available' };
                await window.electronAPI.macrosStop();
                return { ok: true };
            },

            // ── Clipboard ──
            'clipboard.recopy': async () => {
                if (!window.electronAPI?.clipboardGet) return { ok: false, message: 'Clipboard History isn’t available' };
                if (!isMiniWidgetEnabled('clipboard')) return { ok: false, message: 'Clipboard History widget is off' };
                const data = await window.electronAPI.clipboardGet();
                const items = data && Array.isArray(data.items) ? data.items : [];
                if (!items.length) return { ok: false, message: 'Your clipboard history is empty' };
                await window.electronAPI.clipboardCopy(items[0].id);
                return { ok: true, message: 'Copied the last clip' };
            },
            'clipboard.clear': async () => {
                if (!window.electronAPI?.clipboardClear) return { ok: false, message: 'Clipboard History isn’t available' };
                await window.electronAPI.clipboardClear();
                return { ok: true };
            },

            // ── Timer, fuller ──
            'timer.pause': () => voiceTimerCall('timerPause', 'Timer paused'),
            'timer.resume': () => voiceTimerCall('timerResume', 'Timer running'),
            'timer.restart': () => voiceTimerCall('timerRestart', 'Timer restarted'),
            'timer.status': () => {
                if (typeof getTimerState !== 'function' || typeof timerRemaining !== 'function') {
                    return { ok: false, message: 'Timer isn’t available' };
                }
                const st = getTimerState();
                const left = timerRemaining(st);
                if (!st || !left || left <= 0) return { ok: false, message: 'No timer running' };
                const fmt = typeof formatTimerClock === 'function' ? formatTimerClock(left) : Math.round(left / 1000) + 's';
                const mins = Math.round(left / 60000);
                const ends = new Date(Date.now() + left);
                return {
                    ok: true,
                    answer: {
                        speech: mins >= 1
                            ? `${mins} minute${mins === 1 ? '' : 's'} left`
                            : `${Math.round(left / 1000)} seconds left`,
                        headline: fmt,
                        detail: 'Ends at ' + ends.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                        meta: []
                    }
                };
            },
            'notes.new': async () => {
                if (typeof notesAddNote !== 'function') return { ok: false, message: 'Quick Notes isn’t available' };
                if (!isMiniWidgetEnabled('notesEnhanced')) return { ok: false, message: 'Quick Notes Enhanced is off' };
                await focusLauncherWindow();
                notesAddNote();
                return { ok: true };
            },

            // ── Widgets & app control ──
            'widget.enable': (params) => voiceToggleWidget(params, true),
            'widget.disable': (params) => voiceToggleWidget(params, false),
            'app.minimize': () => {
                if (!window.electronAPI?.minimizeWindow) return { ok: false, message: 'Can’t do that here' };
                window.electronAPI.minimizeWindow();
                return { ok: true };
            },
            'app.checkUpdates': async () => {
                if (!window.electronAPI?.updatesCheck) return { ok: false, message: 'Updates aren’t available' };
                const res = await window.electronAPI.updatesCheck();
                if (res && res.available) return { ok: true, message: `Update available: ${res.version || 'new version'}` };
                return { ok: true, message: 'You’re up to date' };
            },
            'app.openLogs': async () => {
                if (!window.electronAPI?.openLogFolder) return { ok: false, message: 'Logs aren’t available' };
                await window.electronAPI.openLogFolder();
                return { ok: true };
            },
            'app.account': async () => {
                if (!window.electronAPI?.licenseOpenAccount) return { ok: false, message: 'Account isn’t available' };
                await window.electronAPI.licenseOpenAccount();
                return { ok: true };
            },
            'app.autostartOn': () => voiceSetAutostart(true),
            'app.autostartOff': () => voiceSetAutostart(false),
            'search.reindex': async () => {
                if (!window.electronAPI?.fileSearchBuildIndex) return { ok: false, message: 'File Search isn’t available' };
                if (!isMiniWidgetEnabled('fileSearch')) return { ok: false, message: 'File Search widget is off' };
                window.electronAPI.fileSearchBuildIndex();
                return { ok: true, message: 'Rebuilding the file index' };
            },

            // ── Information ──
            'system.time': () => {
                const now = new Date();
                const clock = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                const h = now.getHours();
                const mins = now.getMinutes();
                // Follow the machine's own clock convention: reading "nine in the
                // evening" to someone whose clock says 21:00 is the same class of
                // mistake as answering in the wrong temperature unit.
                const uses24 = !/[ap]\.?m\.?/i.test(clock);
                let spoken;
                if (uses24) {
                    spoken = mins === 0 ? `It's ${h} hundred hours` : `It's ${h} ${mins < 10 ? 'oh ' + mins : mins}`;
                } else {
                    const h12 = h % 12 === 0 ? 12 : h % 12;
                    const part = h < 12 ? 'in the morning' : h < 18 ? 'in the afternoon' : 'in the evening';
                    spoken = mins === 0
                        ? `It's ${h12} o'clock ${part}`
                        : `It's ${h12} ${mins < 10 ? 'oh ' + mins : mins} ${part}`;
                }
                return {
                    ok: true,
                    answer: {
                        speech: spoken,
                        headline: clock,
                        detail: now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
                        meta: []
                    }
                };
            },
            'weather.forecast': async () => {
                if (!window.electronAPI?.getWeather) return { ok: false, message: 'Weather isn’t available' };
                const data = await window.electronAPI.getWeather();
                const day = data && Array.isArray(data.forecast) ? data.forecast[0] : null;
                if (!day) return { ok: false, message: 'No forecast available' };
                const unit = localStorage.getItem('weatherUnit') || 'C';
                const hi = Math.round(unit === 'F' ? day.maxtemp_F : day.maxtemp_C);
                const lo = Math.round(unit === 'F' ? day.mintemp_F : day.mintemp_C);
                const cond = day.condition ? String(day.condition) : '';
                return {
                    ok: true,
                    answer: {
                        speech: `Tomorrow, a high of ${hi} and a low of ${lo}${cond ? ', ' + cond.toLowerCase() : ''}`,
                        headline: `${hi}° / ${lo}°`,
                        detail: cond || 'Tomorrow',
                        meta: [`High ${hi}°`, `Low ${lo}°`]
                    }
                };
            },

            // ── Routines ──
            // A routine is the user's own named sequence of commands. Each step is
            // dispatched through the same executor table, so a routine can never do
            // anything a single spoken command couldn't.
            'routine.run': async (params) => {
                const routine = voiceFindRoutine(params && params.routine);
                if (!routine) return { ok: false, message: 'I don’t know that routine' };
                const steps = Array.isArray(routine.steps) ? routine.steps : [];
                if (!steps.length) return { ok: false, message: `${routine.name} has no steps` };
                let done = 0;
                const failures = [];
                for (const step of steps) {
                    const m = await voiceMatchStep(step);
                    if (!m) { failures.push(step); continue; }
                    const r = await runVoiceCommand(m.commandId, m.params);
                    if (r && r.ok) done++;
                    else failures.push(step);
                }
                if (!done) return { ok: false, message: `${routine.name} didn’t run` };
                return {
                    ok: true,
                    message: failures.length
                        ? `${routine.name} — ${done} of ${steps.length} steps`
                        : `${routine.name} · ${done} step${done === 1 ? '' : 's'}`
                };
            },
        };

        async function runVoiceCommand(commandId, params) {
            const fn = VOICE_EXECUTORS[commandId];
            if (typeof fn !== 'function') {
                // A registry entry with no executor is a bug, not a user error — say so
                // rather than reporting a success that did nothing.
                console.error('Voice: no executor for command', commandId);
                return { ok: false, message: 'That isn’t wired up yet' };
            }
            try {
                const result = await fn(params || {});
                return (result && typeof result === 'object') ? result : { ok: true };
            } catch (e) {
                console.error('Voice command failed', commandId, e);
                return { ok: false, message: 'That didn’t work' };
            }
        }

        // ── Wiring ───────────────────────────────────────────────────────────
        if (window.electronAPI?.onVoiceExecute) {
            window.electronAPI.onVoiceExecute(async (payload) => {
                if (!payload || typeof payload.commandId !== 'string') return;
                const result = await runVoiceCommand(payload.commandId, payload.params);
                if (!window.electronAPI?.voiceExecuteResult) return;
                try {
                    await window.electronAPI.voiceExecuteResult({
                        requestId: payload.requestId,
                        ok: !!result.ok,
                        message: result.message || null,
                        // The rich answer an executor may return (a temperature,
                        // a track, a time). Whitelisted field by field: this
                        // crosses an IPC boundary, and the overlay renders it.
                        answer: result.answer ? {
                            speech: String(result.answer.speech || '').slice(0, 240),
                            headline: String(result.answer.headline || '').slice(0, 60),
                            detail: String(result.answer.detail || '').slice(0, 90),
                            meta: Array.isArray(result.answer.meta)
                                ? result.answer.meta.slice(0, 4).map((m) => String(m).slice(0, 24))
                                : [],
                            // Only an http(s) URL can ever be art. The overlay
                            // re-checks this too — a src attribute is not a
                            // place to trust a value that came from an API.
                            art: /^https?:\/\//i.test(String(result.answer.art || ''))
                                ? String(result.answer.art).slice(0, 400) : ''
                        } : null,
                        // Routines report how much of themselves actually ran, so
                        // the reply can't claim success for a half-failed run.
                        ran: typeof result.ran === 'number' ? result.ran : null,
                        failed: typeof result.failed === 'number' ? result.failed : null
                    });
                } catch (e) {
                    console.error('Voice result could not be returned', e);
                }
            });
        }

        // ── Ducking ──────────────────────────────────────────────────────
        // Drop the music while the assistant is talking, then put it back.
        // The previous level is READ, never assumed: restoring to a guessed
        // number would quietly overwrite whatever the user had set.
        let duckRestoreTo = null;
        if (window.electronAPI?.onVoiceDuck) {
            window.electronAPI.onVoiceDuck(async (payload) => {
                try {
                    if (!window.electronAPI?.spotifyGetCurrentTrack || !window.electronAPI?.spotifySetVolume) return;
                    if (payload && payload.duck) {
                        if (duckRestoreTo !== null) return;      // already ducked
                        const data = await window.electronAPI.spotifyGetCurrentTrack();
                        // The payload from main/spotify.js is flat: volume_percent
                        // is top level, `device` is the device NAME (a string),
                        // and the flag is is_playing.
                        const current = data && typeof data.volume_percent === 'number'
                            ? data.volume_percent : null;
                        // Nothing playing, or no readable level: leave it alone
                        // entirely rather than setting a volume we cannot undo.
                        if (current === null || !data.is_playing) return;
                        duckRestoreTo = current;
                        await window.electronAPI.spotifySetVolume(Math.max(0, Math.round(current * 0.35)));
                    } else if (duckRestoreTo !== null) {
                        const back = duckRestoreTo;
                        duckRestoreTo = null;
                        await window.electronAPI.spotifySetVolume(back);
                    }
                } catch (e) {
                    // Never let ducking break the reply it was meant to support.
                    duckRestoreTo = null;
                }
            });
        }

        if (window.electronAPI?.onVoiceState) {
            window.electronAPI.onVoiceState((s) => {
                voiceState = Object.assign({}, voiceState, s || {});
                if (typeof updateVoiceStatusLine === 'function') updateVoiceStatusLine();
            });
        }

        // Called from applyMiniWidgetPrefs() — mirrors how every other widget with a
        // main-process half is switched on and off.
        async function applyVoiceAssistantEnabled(enabled) {
            if (!window.electronAPI?.voiceSetEnabled) return;
            try {
                await window.electronAPI.voiceSetEnabled(!!enabled);
                if (enabled) {
                    await pushVoiceVocabulary(true);
                    // Don't block the toggle on three IPC round-trips.
                    refreshVoiceLiveVocabulary().catch(() => {});
                }
            } catch (e) {
                console.error('Voice assistant could not be toggled', e);
            }
        }

        // ── Config panel ─────────────────────────────────────────────────────
        // Rendered into #voice-assistant-panel inside the Widget Library detail
        // view. Like every panel in this app it must no-op when its div is absent —
        // the div only exists while that widget's detail is open.

        let voiceSettings = null;      // last snapshot from voice:settings-get
        let voiceHostInfo = null;      // last snapshot from voice:get-state

        // Every control writes through this, so persistence has exactly one path.
        async function voiceSetSetting(key, value) {
            if (!window.electronAPI?.voiceSettingsSet) return;
            try {
                voiceSettings = await window.electronAPI.voiceSettingsSet({ [key]: value });
            } catch (e) {
                console.error('Voice setting could not be saved', e);
                showToast('Couldn’t save that setting', true);
                return;
            }
            renderVoiceAssistantPanel();
        }

        // Raw setting values are not what a person should read: a confidence
        // threshold of 0.6 and a timeout of 7000 mean nothing on their own.
        function voiceFormatSliderValue(mode, value) {
            const n = Number(value);
            if (mode === 'percent') return Math.round(n * 100) + '%';
            if (mode === 'seconds') return (n / 1000).toFixed(1) + 's';
            if (mode === 'times') return n.toFixed(2).replace(/0$/, '') + '×';
            return String(n);
        }

        // Readout updates on drag; the value only persists on release, so dragging
        // across the range doesn't write a dozen settings files.
        function voiceSetSliderLive(key, value, mode) {
            const el = document.getElementById('voice-val-' + key);
            if (el) el.textContent = voiceFormatSliderValue(mode, value);
        }

        function voiceSliderRow(label, key, min, max, step, value, mode, title) {
            return `<div class="flex items-center gap-3"${title ? ` title="${esc(title)}"` : ''}>
                <span class="text-[11px] text-neutral-400 w-[92px] shrink-0">${esc(label)}</span>
                <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
                    class="ve-vol-slider flex-1 no-drag"
                    oninput="voiceSetSliderLive(${jsAttr(key)}, this.value, ${jsAttr(mode || '')})"
                    onchange="voiceSetSetting(${jsAttr(key)}, this.valueAsNumber)">
                <span class="ve-vol-val" id="voice-val-${key}">${voiceFormatSliderValue(mode, value)}</span>
            </div>`;
        }

        // `label` may contain deliberate HTML entities (curly quotes), so it is
        // passed through as-is; every caller is a literal in this file, never user
        // input. `hint` is escaped normally.
        // ── Collapsible sections ─────────────────────────────────────────────
        // The panel outgrew a single scroll: activation, wake word, appearance,
        // behaviour, routines and the command tester are six distinct jobs. Each
        // is a section that remembers whether it is open, so the panel opens the
        // way the user left it rather than as one long wall.
        const VOICE_SECTIONS = ['activation', 'wake', 'appearance', 'behaviour', 'routines', 'try'];
        const VOICE_SECTIONS_DEFAULT_OPEN = ['activation'];

        function getVoiceOpenSections() {
            const saved = safeParseJSON(localStorage.getItem('voicePanelSections'), null);
            if (!Array.isArray(saved)) return VOICE_SECTIONS_DEFAULT_OPEN.slice();
            return saved.filter(id => VOICE_SECTIONS.includes(id));
        }

        function isVoiceSectionOpen(id) {
            return getVoiceOpenSections().includes(id);
        }

        // Toggles in place rather than re-rendering the whole panel: a full
        // re-render would lose the routine draft and the focus ring.
        function voiceToggleSection(id) {
            const open = getVoiceOpenSections();
            const next = open.includes(id) ? open.filter(x => x !== id) : open.concat([id]);
            localStorage.setItem('voicePanelSections', JSON.stringify(next));
            const body = document.getElementById('voice-sec-' + id);
            const head = document.getElementById('voice-sec-head-' + id);
            const nowOpen = next.includes(id);
            if (body) body.classList.toggle('hidden', !nowOpen);
            if (head) {
                head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
                const chev = head.querySelector('.voice-sec-chev');
                if (chev) chev.style.transform = nowOpen ? 'rotate(90deg)' : 'rotate(0deg)';
            }
        }

        // ── Training ─────────────────────────────────────────────────────
        // A prompt-at-a-time flow. Everything is rebuilt from `voiceTrainState`
        // so the panel can be closed and reopened mid-run without losing it.
        let voiceTrainState = { running: false, prompts: [], index: 0, samples: [], result: null };

        function voiceTrainRender() {
            const box = document.getElementById('voice-train-body');
            if (!box) return;                     // panel closed — nothing to draw
            box.textContent = '';
            const st = voiceTrainState;

            const btn = (label, fn, primary) => {
                const b = document.createElement('button');
                b.className = 'w-full text-[11px] py-1.5 rounded-lg no-drag border ' + (primary
                    ? 'bg-white/90 text-neutral-900 border-white/20 hover:bg-white'
                    : 'bg-neutral-800/50 text-neutral-300 border-neutral-700/50 hover:bg-neutral-700/50');
                b.textContent = label;
                b.addEventListener('click', fn);
                return b;
            };

            if (st.result) {
                const r = st.result;
                const head = document.createElement('div');
                head.className = 'text-[11px] text-neutral-200 mb-1';
                head.textContent = `Heard ${r.heardCount} of ${r.total} · ${r.accuracy}% matched first time`;
                box.appendChild(head);

                const mic = document.createElement('div');
                mic.className = 'text-[10px] mb-2 ' + (r.lowMic ? 'text-amber-400' : 'text-neutral-500');
                mic.textContent = r.lowMic
                    ? `Microphone peak ${r.peakMedian} — very quiet. This is the main limit on accuracy; a headset will beat any setting.`
                    : `Microphone peak ${r.peakMedian} — healthy.`;
                box.appendChild(mic);

                for (const m of r.misheard.slice(0, 6)) {
                    const row = document.createElement('div');
                    row.className = 'text-[10px] text-neutral-400 px-2 py-1 rounded bg-neutral-800/40 mb-1';
                    row.textContent = `“${m.said}” → heard “${m.heard}”`;
                    box.appendChild(row);
                }

                const n = Object.values(r.aliases || {}).reduce((a, l) => a + l.length, 0);
                const summary = document.createElement('p');
                summary.className = 'text-[10px] text-neutral-500 my-1.5 leading-relaxed';
                summary.textContent = n
                    ? `Applying will teach Main ${n} extra wording${n === 1 ? '' : 's'}` +
                      (r.confidence !== null ? ` and set your confidence threshold to ${Math.round(r.confidence * 100)}%.` : '.')
                    : (r.confidence !== null
                        ? `Nothing was misheard. Applying will set your confidence threshold to ${Math.round(r.confidence * 100)}%.`
                        : 'Nothing to apply — try again somewhere quieter.');
                box.appendChild(summary);

                if (n || r.confidence !== null) box.appendChild(btn('Apply', voiceTrainApply, true));
                box.appendChild(btn('Start again', voiceTrainStart));
                return;
            }

            if (!st.running) {
                box.appendChild(btn('Start training', voiceTrainStart, true));
                return;
            }

            const prompt = st.prompts[st.index];
            const prog = document.createElement('div');
            prog.className = 'text-[10px] text-neutral-500 mb-1';
            prog.textContent = `Phrase ${st.index + 1} of ${st.prompts.length}`;
            box.appendChild(prog);

            const say = document.createElement('div');
            say.className = 'text-[15px] text-white font-medium mb-2';
            say.textContent = '“' + (prompt ? prompt.say : '') + '”';
            box.appendChild(say);

            const status = document.createElement('div');
            status.id = 'voice-train-status';
            status.className = 'text-[11px] text-neutral-400 mb-2 min-h-[16px]';
            status.textContent = st.listening ? 'Listening…' : 'Ready';
            box.appendChild(status);

            if (!st.listening) box.appendChild(btn('Speak now', voiceTrainStep, true));
            box.appendChild(btn('Stop', voiceTrainStop));
        }

        async function voiceTrainStart() {
            if (!window.electronAPI?.voiceTrainPrompts) return;
            const prompts = await window.electronAPI.voiceTrainPrompts();
            voiceTrainState = { running: true, prompts: prompts || [], index: 0, samples: [], result: null, listening: false };
            voiceTrainRender();
        }

        async function voiceTrainStep() {
            const st = voiceTrainState;
            const prompt = st.prompts[st.index];
            if (!prompt || !window.electronAPI?.voiceTrainListen) return;
            st.listening = true;
            voiceTrainRender();

            const r = await window.electronAPI.voiceTrainListen(7000);
            st.listening = false;
            st.samples.push({
                commandId: prompt.commandId, said: prompt.say,
                heard: r.heard, confidence: r.confidence, peak: r.peak, matchedId: r.matchedId
            });

            const status = document.getElementById('voice-train-status');
            if (status) {
                status.textContent = !r.heard ? 'Did not hear that'
                    : r.matchedId === prompt.commandId ? 'Got it'
                    : 'Heard “' + r.heard + '”';
            }
            st.index++;
            if (st.index >= st.prompts.length) {
                st.running = false;
                st.result = await window.electronAPI.voiceTrainAnalyze(st.samples);
            }
            // A beat so the outcome of the last phrase is readable.
            setTimeout(voiceTrainRender, st.result ? 700 : 500);
        }

        async function voiceTrainStop() {
            try { await window.electronAPI?.voiceTrainCancel?.(); } catch (e) { /* already idle */ }
            voiceTrainState = { running: false, prompts: [], index: 0, samples: [], result: null };
            voiceTrainRender();
        }

        async function voiceTrainApply() {
            const r = voiceTrainState.result;
            if (!r) return;
            // Aliases live with the user's own data, alongside routines.
            if (r.aliases && Object.keys(r.aliases).length) {
                let existing = {};
                try { existing = JSON.parse(localStorage.getItem('voiceAliases') || '{}'); } catch (e) { /* corrupt */ }
                for (const [id, list] of Object.entries(r.aliases)) {
                    const have = new Set(existing[id] || []);
                    for (const phrase of list) have.add(phrase);
                    existing[id] = [...have];
                }
                localStorage.setItem('voiceAliases', JSON.stringify(existing));
                // Rebuild the grammar so the new wordings are hearable immediately.
                if (typeof pushVoiceVocabulary === 'function') pushVoiceVocabulary(true);
            }
            if (r.confidence !== null && window.electronAPI?.voiceSettingsSet) {
                await window.electronAPI.voiceSettingsSet({ confidence: r.confidence });
            }
            voiceTrainState.result = null;
            voiceTrainState.applied = true;
            const box = document.getElementById('voice-train-body');
            if (box) {
                box.textContent = '';
                const done = document.createElement('p');
                done.className = 'text-[11px] text-emerald-400';
                done.textContent = 'Applied. Try the phrases that were misheard again.';
                box.appendChild(done);
            }
        }

        // Opens Windows' own speech settings, where "Train your computer to
        // better understand you" lives.
        //
        // Goes through a dedicated main handler that takes no argument. Not
        // open-external — that refuses non-web URLs by design — and not the voice
        // module, which is barred from spawning processes. `ms-settings:speech`
        // was also simply the wrong page: it is modern voice typing, not the
        // trainer for the SAPI recognizer this assistant uses.
        async function voiceOpenWindowsTraining() {
            if (!window.electronAPI?.openSpeechTraining) return;
            const ok = await window.electronAPI.openSpeechTraining();
            if (!ok && typeof showToast === 'function') {
                showToast('Windows speech training is not available on this PC');
            }
        }

        // Renders the recognition log. Panels must no-op when their div is
        // absent — it only exists while the detail view is open.
        async function voiceRefreshHistory() {
            const box = document.getElementById('voice-history');
            if (!box) return;
            if (!window.electronAPI?.voiceGetHistory) { box.textContent = 'Not available'; return; }
            let data = null;
            try { data = await window.electronAPI.voiceGetHistory(); } catch (e) { /* main is busy */ }
            const rows = (data && Array.isArray(data.history)) ? data.history : [];
            box.textContent = '';
            if (!rows.length) {
                const p = document.createElement('p');
                p.className = 'text-[11px] text-neutral-600';
                p.textContent = 'Nothing yet — say something to the assistant, then refresh.';
                box.appendChild(p);
                return;
            }
            for (const r of rows) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 text-[10px] px-2 py-1 rounded bg-neutral-800/40 border border-neutral-700/40';

                const peak = Number(r.peak) || 0;
                const lvl = document.createElement('span');
                // The single most diagnostic number on the row.
                lvl.className = 'font-mono w-7 shrink-0 ' + (peak < 15 ? 'text-amber-400' : 'text-neutral-500');
                lvl.textContent = String(peak);
                lvl.title = peak < 15 ? 'Very quiet — the microphone is likely the limiting factor' : 'Peak input level';
                row.appendChild(lvl);

                const said = document.createElement('span');
                said.className = 'flex-1 truncate text-neutral-200';
                said.textContent = r.transcript || '(nothing)';
                row.appendChild(said);

                const tag = document.createElement('span');
                const ok = r.outcome === 'matched' || r.outcome === 'freeform';
                tag.className = 'shrink-0 ' + (ok ? 'text-emerald-400' : r.outcome === 'unknown' ? 'text-rose-400' : 'text-neutral-500');
                tag.textContent = r.outcome === 'matched' ? (r.commandId || 'matched')
                    : r.outcome === 'freeform' ? (r.commandId || 'dictation')
                    : r.outcome === 'heard-only' ? 'heard, no match'
                    : r.outcome;
                row.appendChild(tag);

                if (r.viaFree) {
                    const f = document.createElement('span');
                    f.className = 'shrink-0 text-[9px] text-sky-400/70';
                    f.textContent = 'dict';
                    f.title = 'Understood through free dictation rather than the command grammar';
                    row.appendChild(f);
                }
                box.appendChild(row);
            }
        }

        function voiceSection(id, title, summary, bodyHtml) {
            const open = isVoiceSectionOpen(id);
            return `<div class="rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <button type="button" id="voice-sec-head-${id}" aria-expanded="${open ? 'true' : 'false'}"
                    onclick="voiceToggleSection(${jsAttr(id)})"
                    class="w-full flex items-center gap-2 px-3 py-2.5 text-left no-drag hover:bg-white/[0.03] transition-colors">
                    <i class="fas fa-chevron-right text-[8px] text-neutral-500 voice-sec-chev transition-transform duration-200"
                        style="transform: rotate(${open ? '90' : '0'}deg)"></i>
                    <span class="text-[11.5px] text-neutral-200 flex-1">${esc(title)}</span>
                    <span class="text-[9.5px] text-neutral-600 truncate max-w-[46%]">${esc(summary)}</span>
                </button>
                <div id="voice-sec-${id}" class="${open ? '' : 'hidden'} px-3 pb-3">${bodyHtml}</div>
            </div>`;
        }

        // Segmented picker for the look settings. Each option carries a one-line
        // description, because "crt" means nothing until you read what it does.
        function voicePicker(label, key, current, options, hint) {
            return `<div class="mb-2">
                <p class="text-[11px] text-neutral-400 mb-1.5">${esc(label)}</p>
                <div class="grid grid-cols-2 gap-1.5">
                    ${options.map(o => `
                    <button type="button" onclick="voiceSetSetting(${jsAttr(key)}, ${jsAttr(o.id)})"
                        class="px-2 py-1.5 rounded-lg text-[11px] border transition-colors no-drag text-left ${current === o.id
                            ? 'bg-white/15 border-white/25 text-white'
                            : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">
                        ${esc(o.label)}<span class="block text-[9px] opacity-60 mt-0.5">${esc(o.hint)}</span>
                    </button>`).join('')}
                </div>
                ${hint ? `<p class="text-[10px] text-neutral-600 mt-1.5">${esc(hint)}</p>` : ''}
            </div>`;
        }

        const VOICE_TRANSITIONS = [
            { id: 'fade', label: 'Soft fade', hint: 'Drifts in and out' },
            { id: 'crt', label: 'CRT power-off', hint: 'Collapses to a line, then a spark' },
            { id: 'collapse', label: 'Collapse', hint: 'Shrinks to a point' },
            { id: 'slide', label: 'Slide', hint: 'Drops from the top' }
        ];
        const VOICE_VIZ_STYLES = [
            { id: 'aurora', label: 'Aurora', hint: 'Layered morphing rings' },
            { id: 'bars', label: 'Equaliser', hint: 'Radial spectrum bars' },
            { id: 'pulse', label: 'Pulse', hint: 'Calm travelling rings' },
            { id: 'ribbons', label: 'Ribbons', hint: 'Flowing bands of colour' },
            { id: 'prism', label: 'Prism', hint: 'Iridescent colour bloom' }
        ];

        function voiceToggleRow(label, key, checked, hint) {
            return `<label class="flex items-center justify-between gap-3 cursor-pointer text-xs">
                <span class="min-w-0">
                    <span>${label}</span>
                    ${hint ? `<span class="block text-[10px] text-neutral-600 leading-tight mt-0.5">${esc(hint)}</span>` : ''}
                </span>
                <span class="ios-toggle shrink-0"><input type="checkbox" class="ios-toggle-input" ${checked ? 'checked' : ''}
                    onchange="voiceSetSetting(${jsAttr(key)}, this.checked)"><span class="ios-toggle-track"></span></span>
            </label>`;
        }

        // Live engine/permission status. The panel is where someone looks to find
        // out WHY the assistant isn't answering, so it reports the real reason
        // instead of a bare "on".
        function voiceStatusLineHtml() {
            const info = voiceHostInfo || {};
            if (info.supported === false) {
                return '<span class="text-amber-400/80">Windows only — this uses the speech recogniser built into Windows</span>';
            }
            if (info.micState === 'denied') {
                return '<span class="text-amber-400/80">Microphone blocked — allow it in Windows Settings › Privacy › Microphone</span>';
            }
            if (info.micState === 'missing') {
                return '<span class="text-amber-400/80">No microphone found — you can still type commands below</span>';
            }
            if (!info.hostReady) {
                return '<span class="text-neutral-500">Speech engine starting…</span>';
            }
            // While the wake word is on the microphone is genuinely open, so say
            // so plainly rather than reporting a generic "Ready".
            if (info.hostMode === 'wake') {
                return `<span class="text-neutral-400"><i class="fas fa-circle text-[6px] align-middle mr-1.5 text-emerald-400"></i>Listening for &ldquo;hey main&rdquo; — microphone on, nothing leaves this PC</span>`;
            }
            return `<span class="text-neutral-500">Ready · ${esc(info.recognizerName || 'recogniser')} · ${info.phrases || 0} phrases · fully offline</span>`;
        }

        function updateVoiceStatusLine() {
            voiceHostInfo = Object.assign({}, voiceHostInfo, voiceState);
            const el = document.getElementById('voice-status-line');
            if (el) el.innerHTML = voiceStatusLineHtml();
        }

        async function voiceTryTyped(value) {
            const text = String(value || '').trim();
            if (!text || !window.electronAPI?.voiceSubmitText) return;
            const input = document.getElementById('voice-try-input');
            if (input) input.value = '';
            try {
                await window.electronAPI.voiceSubmitText(text);
            } catch (e) {
                showToast('Couldn’t run that', true);
            }
        }

        function voiceTryKeyDown(event) {
            if (event.key === 'Enter') { event.preventDefault(); voiceTryTyped(event.target.value); }
        }


        // ── Routines UI ──────────────────────────────────────────────────────
        // A routine is a name plus a list of commands in the user's own words.
        // Every step is validated through the real matcher before it can be
        // saved, so a routine can never contain something the assistant would not
        // understand when spoken.

        let voiceRoutineDraft = { name: '', steps: '' };
        let voiceRoutineCheck = [];   // per-line { text, ok, title }

        function voiceRoutineLines(text) {
            return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12);
        }

        async function voiceValidateRoutineDraft() {
            const lines = voiceRoutineLines(voiceRoutineDraft.steps);
            const checked = [];
            for (const line of lines) {
                const m = await voiceMatchStep(line);
                checked.push({ text: line, ok: !!m, title: m ? (m.title || m.commandId) : null });
            }
            voiceRoutineCheck = checked;
            const box = document.getElementById('voice-routine-check');
            if (!box) return;
            box.innerHTML = checked.length ? checked.map(c => `
                <div class="flex items-start gap-1.5 text-[10px] leading-tight ${c.ok ? 'text-neutral-400' : 'text-amber-400/80'}">
                    <i class="fas ${c.ok ? 'fa-check' : 'fa-triangle-exclamation'} text-[8px] mt-[3px]"></i>
                    <span class="min-w-0"><span class="text-neutral-300">${esc(c.text)}</span>${c.ok
                        ? ` <span class="text-neutral-600">→ ${esc(c.title)}</span>`
                        : ' <span class="text-amber-400/70">— not a command I know</span>'}</span>
                </div>`).join('') : '';
        }

        function voiceRoutineDraftInput(field, value) {
            voiceRoutineDraft[field] = value;
            if (field === 'steps') {
                clearTimeout(voiceRoutineDraftInput._t);
                voiceRoutineDraftInput._t = setTimeout(() => voiceValidateRoutineDraft(), 260);
            }
        }

        async function voiceRoutineSave() {
            const name = String(voiceRoutineDraft.name || '').trim();
            const lines = voiceRoutineLines(voiceRoutineDraft.steps);
            if (!name) { showToast('Give the routine a name', true); return; }
            if (!lines.length) { showToast('Add at least one command', true); return; }

            // The name has to be sayable, or the routine can never be triggered.
            const spoken = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            if (!spoken) { showToast('That name can’t be spoken — use words', true); return; }

            await voiceValidateRoutineDraft();
            const bad = voiceRoutineCheck.filter(c => !c.ok);
            if (bad.length) { showToast(`${bad.length} step${bad.length === 1 ? '' : 's'} not understood`, true); return; }

            const list = getVoiceRoutines();
            if (list.some(r => r.name.toLowerCase() === name.toLowerCase())) {
                showToast('A routine with that name already exists', true);
                return;
            }
            list.push({ id: 'r' + Date.now().toString(36), name, steps: lines });
            saveVoiceRoutines(list);
            voiceRoutineDraft = { name: '', steps: '' };
            voiceRoutineCheck = [];
            showToast(`Routine “${name}” saved`);
            renderVoiceAssistantPanel();
        }

        function voiceRoutineDelete(id) {
            const list = getVoiceRoutines().filter(r => r.id !== id);
            saveVoiceRoutines(list);
            renderVoiceAssistantPanel();
        }

        function voiceRoutineRun(id) {
            const r = voiceFindRoutine(id);
            if (!r || !window.electronAPI?.voiceSubmitText) return;
            window.electronAPI.voiceSubmitText(r.name);
        }

        function voiceRoutinesHtml() {
            const list = getVoiceRoutines();
            const rows = list.map(r => `
                <div class="flex items-center gap-2 py-1.5 border-b border-white/[0.06] last:border-0">
                    <div class="min-w-0 flex-1">
                        <div class="text-[11.5px] text-white truncate">${esc(r.name)}</div>
                        <div class="text-[9.5px] text-neutral-600 truncate">${esc((r.steps || []).join(' · '))}</div>
                    </div>
                    <button type="button" title="Run now" onclick="voiceRoutineRun(${jsAttr(r.id)})"
                        class="px-2 py-1 rounded-md text-[10px] bg-white/[0.07] border border-white/10 text-neutral-300 hover:text-white transition-colors no-drag">
                        <i class="fas fa-play text-[8px]"></i></button>
                    <button type="button" title="Delete" onclick="voiceRoutineDelete(${jsAttr(r.id)})"
                        class="px-2 py-1 rounded-md text-[10px] bg-white/[0.04] border border-white/10 text-neutral-500 hover:text-red-300 transition-colors no-drag">
                        <i class="fas fa-trash text-[8px]"></i></button>
                </div>`).join('');

            return `
                <div>
                    <p class="text-[10px] text-neutral-600 mb-2 leading-relaxed">
                        Your own multi-step commands. Say the routine's name and every step runs in order.
                    </p>
                    ${list.length ? `<div class="mb-2">${rows}</div>`
                        : '<p class="text-[10px] text-neutral-600 mb-2 italic">No routines yet — try one called “gaming mode”.</p>'}
                    <input id="voice-routine-name" type="text" spellcheck="false" placeholder="Routine name, e.g. gaming mode"
                        value="${esc(voiceRoutineDraft.name)}"
                        class="w-full bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-2.5 py-2 text-[11px] text-neutral-200 no-drag mb-1.5"
                        oninput="voiceRoutineDraftInput('name', this.value)">
                    <textarea id="voice-routine-steps" spellcheck="false" rows="3"
                        placeholder="One command per line:&#10;optimize my pc&#10;show the crosshair&#10;mute my mic"
                        class="w-full bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-2.5 py-2 text-[11px] text-neutral-200 no-drag resize-none"
                        oninput="voiceRoutineDraftInput('steps', this.value)">${esc(voiceRoutineDraft.steps)}</textarea>
                    <div id="voice-routine-check" class="space-y-0.5 mt-1.5"></div>
                    <button type="button" onclick="voiceRoutineSave()"
                        class="mt-2 px-3 py-1.5 rounded-lg text-[11px] bg-white/[0.10] border border-white/15 text-white hover:bg-white/[0.16] transition-colors no-drag">
                        Save routine
                    </button>
                </div>`;

            // The step checklist lives outside innerHTML, so repaint it.
            if (voiceRoutineDraft.steps) voiceValidateRoutineDraft();
        }

        async function renderVoiceAssistantPanel() {
            const panel = document.getElementById('voice-assistant-panel');
            if (!panel) return;
            if (!isVoiceAssistantEnabled()) { panel.innerHTML = ''; return; }

            // Both reads are cheap, and this only runs while the detail view is open.
            if (window.electronAPI?.voiceSettingsGet) {
                try { voiceSettings = await window.electronAPI.voiceSettingsGet(); } catch (e) { /* keep last */ }
            }
            if (window.electronAPI?.voiceGetState) {
                try { voiceHostInfo = await window.electronAPI.voiceGetState(); } catch (e) { /* keep last */ }
            }
            // The detail view may have been closed during those awaits.
            if (!document.getElementById('voice-assistant-panel')) return;

            const s = voiceSettings || {};
            const info = voiceHostInfo || {};
            const hotkeyLabel = formatHotkeyDisplay(hotkeys.voiceAssistant || DEFAULT_HOTKEYS.voiceAssistant);
            const voices = Array.isArray(info.voices) ? info.voices : [];
            const hold = s.activation === 'hold';

            // Examples are generated from the same vocabulary the recogniser uses, so
            // this list can never drift from what actually works.
            let examples;
            try {
                const vocab = buildVoiceVocabulary();
                const firstApp = vocab.apps.length ? vocab.apps[0].name.toLowerCase() : 'spotify';
                examples = ['launch ' + firstApp, 'next track', 'set the volume to fifty',
                    'open settings', 'set a timer for ten minutes', 'what can I say'];
            } catch (e) {
                examples = ['next track', 'open settings', 'what can I say'];
            }

            panel.innerHTML = `<div class="mt-3 space-y-2">
                <div id="voice-status-line" class="text-[10px] leading-snug">${voiceStatusLineHtml()}</div>

                ${voiceSection('activation', 'Activation',
                    (s.activation === 'hold' ? 'Hold to talk' : 'Press to talk') + ' · ' + formatHotkeyDisplay(hotkeys.voiceAssistant || DEFAULT_HOTKEYS.voiceAssistant),
                    `<div>
                    <div class="grid grid-cols-2 gap-1.5">
                        <button type="button" onclick="voiceSetSetting('activation', 'toggle')"
                            class="px-2 py-2 rounded-lg text-[11px] border transition-colors no-drag ${!hold
                                ? 'bg-white/15 border-white/25 text-white'
                                : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">
                            Press to talk<span class="block text-[9px] opacity-60 mt-0.5">Tap once, tap again to cancel</span>
                        </button>
                        <button type="button" onclick="voiceSetSetting('activation', 'hold')"
                            class="px-2 py-2 rounded-lg text-[11px] border transition-colors no-drag ${hold
                                ? 'bg-white/15 border-white/25 text-white'
                                : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'}">
                            Hold to talk<span class="block text-[9px] opacity-60 mt-0.5">Speak while held, release to send</span>
                        </button>
                    </div>
                    <p class="text-[10px] text-neutral-600 mt-1.5">Hotkey <kbd class="text-neutral-400">${esc(hotkeyLabel)}</kbd> — rebind it with the button above.</p>
                </div>`)}

                ${voiceSection('wake', 'Wake word',
                    s.wakeWord ? 'On — “hey main”' : 'Off',
                    `<div>
                    ${voiceToggleRow('Answer to &ldquo;hey main&rdquo;', 'wakeWord', !!s.wakeWord,
                        'Say it any time instead of pressing the hotkey.')}
                    ${s.wakeWord ? `
                    <div class="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2">
                        <p class="text-[10px] text-amber-200/80 leading-relaxed">
                            <i class="fas fa-microphone text-[9px] mr-1"></i>
                            The microphone stays on while main is running so it can hear you.
                            Recognition is still entirely on this PC — nothing is recorded and
                            nothing is uploaded — but the mic indicator will be lit.
                        </p>
                    </div>
                    <p class="text-[10px] text-neutral-600 mt-2 leading-relaxed">
                        Say <span class="text-neutral-400">&ldquo;hey main&rdquo;</span> on its own, or run a command in
                        one breath: <span class="text-neutral-400">&ldquo;hey main, next track&rdquo;</span>.
                        Also answers to &ldquo;ok main&rdquo;.
                    </p>
                    ${voiceSliderRow('Wake threshold', 'wakeConfidence', 0.6, 0.95, 0.05,
                        (s.wakeConfidence !== undefined ? s.wakeConfidence : 0.85), 'percent',
                        'How certain it must be before waking. Lower is more responsive but conversation nearby can trip it — "hey man" is the usual culprit.')}
                    ` : ''}
                </div>`)}

                ${voiceSection('appearance', 'Appearance',
                    (VOICE_TRANSITIONS.find(o => o.id === (s.transition || 'fade')) || {}).label + ' · ' +
                    (VOICE_VIZ_STYLES.find(o => o.id === (s.vizStyle || 'aurora')) || {}).label + ' · ' +
                    (s.scale !== undefined ? s.scale : 1) + '×',
                    `<div>
                    ${voicePicker('Enter / exit animation', 'transition', s.transition || 'fade', VOICE_TRANSITIONS)}
                    ${voicePicker('Centrepiece', 'vizStyle', s.vizStyle || 'aurora', VOICE_VIZ_STYLES)}
                    ${voiceSliderRow('Panel size', 'scale', 0.7, 1.6, 0.05,
                        (s.scale !== undefined ? s.scale : 1), 'times',
                        'Scales the whole panel. The window grows with it, so a larger panel is never clipped.')}
                </div>`)}

                ${voiceSection('training', 'Train your voice',
                    'Read a few phrases so Main learns how you say them',
                    `<div class="space-y-2">
                    <p class="text-[11px] text-neutral-500 leading-relaxed">
                        Read eight short phrases aloud. Main learns the wordings <em>you</em> actually
                        produce, sets a confidence threshold from your own voice, and measures your
                        microphone. Nothing is recorded &mdash; only what the recognizer made of each phrase.
                    </p>
                    <div id="voice-train-body"></div>
                    <div class="pt-1 border-t border-neutral-700/40">
                        <p class="text-[10px] text-neutral-600 leading-relaxed mb-1.5">
                            Windows owns the acoustic profile &mdash; how your voice <em>sounds</em>. Its own
                            trainer is the only thing that can adapt it, and it is the single biggest
                            accuracy gain available.
                        </p>
                        <button class="w-full text-[11px] py-1.5 rounded-lg bg-neutral-800/50 border border-neutral-700/50 text-neutral-300 hover:bg-neutral-700/50 no-drag"
                            onclick="voiceOpenWindowsTraining()">Open Windows voice training</button>
                    </div>
                </div>`)}

                ${voiceSection('heard', 'What it heard',
                    'Recent utterances, and how loud they were',
                    `<div class="space-y-2">
                    <p class="text-[11px] text-neutral-500 leading-relaxed">
                        Every utterance, what it matched, and the peak microphone level.
                        A low peak (under ~15) means the microphone is the problem, not the wording —
                        a headset will beat a built-in array every time.
                    </p>
                    <button class="w-full text-[11px] py-1.5 rounded-lg bg-neutral-800/50 border border-neutral-700/50 text-neutral-300 hover:bg-neutral-700/50 no-drag"
                        onclick="voiceRefreshHistory()">Refresh</button>
                    <div id="voice-history" class="space-y-1 max-h-44 overflow-y-auto"></div>
                </div>`)}

                ${voiceSection('behaviour', 'Behaviour',
                    [s.voiceFeedback ? 'Speaks' : 'Silent', s.chaining !== false ? 'Chaining' : null,
                     s.confirmRisky === false ? 'No safety prompt' : null,
                     'Strictness ' + Math.round((s.confidence !== undefined ? s.confidence : 0.6) * 100) + '%']
                        .filter(Boolean).join(' · '),
                    `<div class="space-y-2.5">
                    ${voiceToggleRow('Speak replies out loud', 'voiceFeedback', !!s.voiceFeedback,
                        'Off by default — most commands confirm themselves on screen.')}
                    ${s.voiceFeedback && voices.length ? `
                    <div class="flex items-center gap-3">
                        <span class="text-[11px] text-neutral-400 w-[92px] shrink-0">Voice</span>
                        <select class="flex-1 bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-2 py-1.5 text-[11px] text-neutral-200 no-drag"
                            onchange="voiceSetSetting('voiceName', this.value)">
                            <option value=""${!s.voiceName ? ' selected' : ''}>System default</option>
                            ${voices.map(v => `<option value="${esc(v)}"${s.voiceName === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
                        </select>
                    </div>
                    ${voiceSliderRow('Speed', 'speechRate', -5, 5, 1, s.speechRate || 0, 'plain')}` : ''}
                    ${voiceToggleRow('Chain commands in one breath', 'chaining', s.chaining !== false,
                        'e.g. "pause the music and optimize my pc" — up to three at once.')}
                    ${voiceToggleRow('Ask before risky commands', 'confirmRisky', s.confirmRisky !== false,
                        'Speech recognition always returns its closest match, so background noise can land on a real command. This asks first for anything that closes programs, clears something, or changes system settings.')}
                    ${voiceToggleRow('Show what it heard', 'showTranscript', s.showTranscript !== false)}
                    ${voiceToggleRow('Click the orb to listen again', 'clickActivate', s.clickActivate !== false)}
                    ${voiceToggleRow('Reduced motion', 'reducedMotion', !!s.reducedMotion,
                        'Calmer animation. Your system setting is honoured automatically.')}
                </div>

                <div class="space-y-2">
                    ${voiceSliderRow('Strictness', 'confidence', 0.2, 0.95, 0.05,
                        (s.confidence !== undefined ? s.confidence : 0.6), 'percent',
                        'How sure it has to be before acting. Higher means fewer accidental triggers but more repeating yourself. One- and two-word commands always need extra certainty on top of this.')}
                    ${voiceSliderRow('Listen for', 'listenTimeoutMs', 2000, 20000, 500, s.listenTimeoutMs || 7000, 'seconds',
                        'How long the microphone stays open after you activate it.')}
                </div>`)}

                ${voiceSection('routines', 'Routines',
                    (() => { const n = getVoiceRoutines().length; return n ? n + (n === 1 ? ' routine' : ' routines') : 'None yet'; })(),
                    `${voiceRoutinesHtml()}`)}

                ${voiceSection('try', 'Try a command', 'Type instead of speaking',
                    `<div>
                    <input id="voice-try-input" type="text" spellcheck="false" placeholder="e.g. ${esc(examples[0])}"
                        class="w-full bg-neutral-800/40 border border-neutral-700/50 rounded-lg px-2.5 py-2 text-[11px] text-neutral-200 no-drag"
                        onkeydown="voiceTryKeyDown(event)">
                    <p class="text-[10px] text-neutral-600 mt-1.5">Runs it exactly as if you had said it — handy with no microphone.</p>
                    <div class="flex flex-wrap gap-1.5 mt-2">
                        ${examples.map(x => `<button type="button" onclick="voiceTryTyped(${jsAttr(x)})"
                            class="px-2 py-1 rounded-md text-[10px] bg-neutral-800/40 border border-neutral-700/50 text-neutral-400 hover:text-neutral-200 transition-colors no-drag">${esc(x)}</button>`).join('')}
                    </div>
                </div>`)}

                <p class="text-[10px] text-neutral-600 leading-relaxed">
                    Say <span class="text-neutral-400">&ldquo;what can I say&rdquo;</span> for the full list.
                    Recognition runs entirely on this PC — nothing is recorded or uploaded.
                    ${s.wakeWord
                        ? 'With the wake word on, the microphone stays open so it can hear you.'
                        : 'The microphone is only open while the overlay is listening.'}
                </p>
            </div>`;
        }
