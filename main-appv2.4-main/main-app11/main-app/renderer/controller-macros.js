        // ── Controller Macros mini widget UI ──
        // Renders inside #controller-macros-panel (created by the Widget Library
        // detail view for the controllerMacros registry entry). All persistence
        // and playback live in the main process (controller-macros-config.json,
        // main/controllerMacros.js) — this file is purely the management UI.
        // Loads after macros.js on purpose: it reuses its globals (trigger mode
        // lists, mouse-button tables, formatMacroHotkey) and its capture-phase
        // keydown handler must run first so the two widgets' hotkey binders
        // can't fight over the same keystroke.

        let cmData = null;             // last snapshot from controllerMacrosGet
        let cmExpandedId = null;       // macro whose step editor is open
        let cmBindTarget = null;       // { kind: 'macro'|'toggle', id? } while capturing a hotkey
        let cmPickerFor = null;        // { id, type } while choosing a pad button for a new step
        let cmRecording = null;        // active pad-recording session (see cmStartPadRecording)
        let cmSuppressContextMenu = false;
        let cmStickEditFor = null;     // { id, index } stick step whose visual joystick pad is open
        let cmStickDrag = null;        // { id, index, x, y } live while dragging the joystick knob
        let cmTemplateOpen = false;    // ready-made-combo picker visibility
        let cmTemplateGame = null;     // which game's section is shown in the picker

        // Canonical button ids (mirrors PAD_BUTTONS/PAD_TRIGGERS in
        // main/controllerMacros.js) with PlayStation-first labels and the Xbox
        // equivalent shown as a hint. The stored id never changes with pad type.
        const CM_BUTTONS = [
            ['cross', '✕ Cross', 'A'],
            ['circle', '○ Circle', 'B'],
            ['square', '□ Square', 'X'],
            ['triangle', '△ Triangle', 'Y'],
            ['l1', 'L1', 'LB'],
            ['r1', 'R1', 'RB'],
            ['l2', 'L2', 'LT'],
            ['r2', 'R2', 'RT'],
            ['l3', 'L3', 'LS click'],
            ['r3', 'R3', 'RS click'],
            ['share', 'Share', 'Back'],
            ['options', 'Options', 'Start'],
            ['guide', 'PS', 'Guide'],
            ['dpadUp', 'D-Pad ↑', ''],
            ['dpadDown', 'D-Pad ↓', ''],
            ['dpadLeft', 'D-Pad ←', ''],
            ['dpadRight', 'D-Pad →', '']
        ];
        const CM_BTN_META = (() => {
            const m = {};
            for (const [id, ps, xb] of CM_BUTTONS) m[id] = { ps, xb };
            return m;
        })();

        // Standard Gamepad API button indices -> canonical ids (w3c "standard"
        // mapping, which Chromium reports for DualShock and Xbox pads alike).
        const CM_GP_BUTTONS = ['cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2',
            'share', 'options', 'l3', 'r3', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight', 'guide'];

        // Full-deflection direction presets for the visual joystick pad, laid out
        // as a 3×3 keypad. Diagonals use ±71 on both axes so the magnitude matches
        // a real thumbstick's circular travel (√(71²+71²) ≈ 100). Centre (0/0)
        // recentres the stick. Values are in the stick step convention: +Y is up.
        const CM_STICK_PRESETS = [
            { x: -71, y: 71, icon: '↖', label: 'up-left' },
            { x: 0, y: 100, icon: '↑', label: 'up' },
            { x: 71, y: 71, icon: '↗', label: 'up-right' },
            { x: -100, y: 0, icon: '←', label: 'left' },
            { x: 0, y: 0, icon: '⊙', label: 'centre' },
            { x: 100, y: 0, icon: '→', label: 'right' },
            { x: -71, y: -71, icon: '↙', label: 'down-left' },
            { x: 0, y: -100, icon: '↓', label: 'down' },
            { x: 71, y: -71, icon: '↘', label: 'down-right' }
        ];

        // ── Skate "Flick-It" trick library (Classic controls) ──
        // Modelled on EA Skate's Flick-It system for the CLASSIC control preset:
        // flips/shove-its are right-stick motions, GRABS hold a trigger while the
        // right stick points the grab, and MANUALS hold the right stick ~halfway.
        // Directions follow EA's own guide (kickflip = down→up-right, heelflip =
        // down→up-left). Flip corners are stance-sensitive — if your skater's
        // stance mirrors the game's prompts, kickflip/heelflip and FS/BS simply
        // swap, which you can fix by swapping the two macros or editing a corner.
        // With Flick-It sensitivity at 100 the game reads flicks readily, so these
        // use full ±100 / ±71 (diagonal) deflection. Values: +Y up, +X right.
        function cmRs(x, y) { return { t: 'stick', s: 'r', x, y }; }
        function cmLs(x, y) { return { t: 'stick', s: 'l', x, y }; }
        function cmWait(ms) { return { t: 'delay', ms }; }
        // load → brief hold → flick → recentre (the core flip-trick motion)
        function cmSkateTrick(lx, ly, fx, fy, loadMs, flickMs) {
            return [cmRs(lx, ly), cmWait(loadMs || 130), cmRs(fx, fy), cmWait(flickMs || 90), cmRs(0, 0)];
        }
        // sweep the right stick through waypoints (shove-its / spins / drags), recentre
        function cmSkateSweep(points, stepMs) {
            const out = [];
            for (const p of points) { out.push(cmRs(p[0], p[1])); out.push(cmWait(stepMs || 55)); }
            out.push(cmRs(0, 0));
            return out;
        }
        // GRAB: a trigger/bumper must be held while the right stick points the grab.
        // L1 is used here (any of L1/L2/R1/R2 puts the game into grab mode).
        function cmSkateGrab(x, y, holdMs) {
            return [{ t: 'bd', b: 'l1' }, cmRs(x, y), cmWait(holdMs || 700), cmRs(0, 0), { t: 'bu', b: 'l1' }];
        }
        // MANUAL: hold the RIGHT stick roughly halfway (down = manual, up = nose).
        function cmSkateManual(y, holdMs) {
            return [cmRs(0, y), cmWait(holdMs || 1200), cmRs(0, 0)];
        }

        // ── NBA 2K26 "Pro Stick" move library ──
        // Dribble moves, shots and finishes are right-stick (Pro Stick) motions;
        // turbo moves and dunks hold RT (R2 = turbo). Directions follow 2K26's
        // controls for a RIGHT-hand ball handler — dribbling with the other hand
        // mirrors the left/right inputs (like a skater's stance). Live animations
        // still depend on left-stick movement direction and ball hand.
        function cm2kFlick(x, y) { return [cmRs(x, y), cmWait(70), cmRs(0, 0)]; }        // quick flick + release
        function cm2kHold(x, y, holdMs) { return [cmRs(x, y), cmWait(holdMs || 500), cmRs(0, 0)]; } // hold a direction
        function cm2kTurbo(x, y, holdMs) {                                              // hold RT then push the stick
            return [{ t: 'bd', b: 'r2' }, cmRs(x, y), cmWait(holdMs || 250), cmRs(0, 0), { t: 'bu', b: 'r2' }];
        }

        // Ready-made combos. `steps` is a factory so each insert gets a fresh copy,
        // and `group` buckets them under headers in the picker.
        const CM_TEMPLATES = [
            // Flip tricks (load, then flick a corner — kickflip up-right, heel up-left)
            { id: 'ollie', name: 'Ollie', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, -100, 0, 100) },
            { id: 'nollie', name: 'Nollie', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, 100, 0, -100) },
            { id: 'kickflip', name: 'Kickflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, -100, 71, 71) },
            { id: 'heelflip', name: 'Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, -100, -71, 71) },
            { id: 'nollie-kickflip', name: 'Nollie Kickflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, 100, 71, -71) },
            { id: 'nollie-heelflip', name: 'Nollie Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(0, 100, -71, -71) },
            { id: 'varial-kickflip', name: 'Varial Kickflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(-71, -71, 71, 71) },
            { id: 'varial-heelflip', name: 'Varial Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(71, -71, -71, 71) },
            { id: 'hardflip', name: 'Hardflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[0, -100], [71, -71], [0, 100]]) },
            { id: 'inward-heelflip', name: 'Inward Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[0, -100], [-71, -71], [0, 100]]) },
            { id: 'tre-flip', name: '360 Flip (Tre)', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[-100, 0], [0, -100], [71, 71]]) },
            { id: 'laser-flip', name: 'Laser Flip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[100, 0], [0, -100], [-71, 71]]) },
            { id: 'hardflip-360', name: '360 Hardflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[100, 0], [0, -100], [0, 100]]) },
            { id: 'inward-heelflip-360', name: '360 Inward Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateSweep([[-100, 0], [0, -100], [0, 100]]) },
            { id: 'nollie-varial-kickflip', name: 'Nollie Varial Kickflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(-71, 71, 71, -71) },
            { id: 'nollie-varial-heelflip', name: 'Nollie Varial Heelflip', group: 'Skate · Flip tricks', speed: 1, steps: () => cmSkateTrick(71, 71, -71, -71) },

            // Shove-its & spins (load on a low diagonal, drag across to the far side)
            { id: 'shuvit-fs', name: 'Pop Shove-it (FS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[71, -71], [0, -100], [-100, 0]]) },
            { id: 'shuvit-bs', name: 'Pop Shove-it (BS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[-71, -71], [0, -100], [100, 0]]) },
            { id: 'shuvit-360-fs', name: '360 Shove-it (FS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[71, -71], [0, -100], [-100, 0], [0, 100]]) },
            { id: 'shuvit-360-bs', name: '360 Shove-it (BS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[-71, -71], [0, -100], [100, 0], [0, 100]]) },
            { id: 'nollie-shuvit-fs', name: 'Nollie Shove-it (FS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[0, 100], [71, 71], [100, 0]]) },
            { id: 'nollie-shuvit-bs', name: 'Nollie Shove-it (BS)', group: 'Skate · Shove-its & spins', speed: 1, steps: () => cmSkateSweep([[0, 100], [-71, 71], [-100, 0]]) },

            // No comply — inputs not confirmed for skate. Classic; verify in-game
            { id: 'no-comply-fs', name: 'No Comply (FS) ⚠', group: 'Skate · No comply (verify in-game)', speed: 1, steps: () => cmSkateTrick(0, -100, -100, 0) },
            { id: 'no-comply-bs', name: 'No Comply (BS) ⚠', group: 'Skate · No comply (verify in-game)', speed: 1, steps: () => cmSkateTrick(0, -100, 100, 0) },

            // Grabs — HOLD L1 while the right stick points the grab
            { id: 'grab-nosegrab', name: 'Grab — Nosegrab', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(0, 100) },
            { id: 'grab-tailgrab', name: 'Grab — Tailgrab', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(0, -100) },
            { id: 'grab-indy', name: 'Grab — Indy', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(71, -71) },
            { id: 'grab-stalefish', name: 'Grab — Stalefish', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(-71, -71) },
            { id: 'grab-melon', name: 'Grab — Melon', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(-100, 0) },
            { id: 'grab-mute', name: 'Grab — Mute', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(100, 0) },
            { id: 'grab-method', name: 'Grab — Method', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(-71, 71) },
            { id: 'grab-crail', name: 'Grab — Crail', group: 'Skate · Grabs (hold L1 + stick)', speed: 1, steps: () => cmSkateGrab(71, 71) },

            // Manuals — hold the RIGHT stick roughly halfway
            { id: 'manual', name: 'Manual', group: 'Skate · Manuals', speed: 1, steps: () => cmSkateManual(-50) },
            { id: 'nose-manual', name: 'Nose Manual', group: 'Skate · Manuals', speed: 1, steps: () => cmSkateManual(50) },

            // ── NBA 2K26 · Dribble moves (Pro Stick, right-hand handler) ──
            { id: '2k-sizeup', name: 'Signature Size-up', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kHold(0, 100, 500) },
            { id: '2k-hesitation', name: 'Hesitation', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(100, 0) },
            { id: '2k-hesi-escape', name: 'Hesitation Escape', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kHold(100, 0, 350) },
            { id: '2k-in-and-out', name: 'In & Out', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(71, 71) },
            { id: '2k-crossover', name: 'Crossover', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(-71, 71) },
            { id: '2k-cross-escape', name: 'Crossover Escape', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kHold(-71, 71, 350) },
            { id: '2k-between-legs', name: 'Between the Legs', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(-100, 0) },
            { id: '2k-behind-back', name: 'Behind the Back', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(-71, -71) },
            { id: '2k-stepback', name: 'Stepback', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cm2kFlick(0, -100) },
            { id: '2k-spin', name: 'Spin Move', group: 'NBA 2K26 · Dribble', speed: 1, steps: () => cmSkateSweep([[0, 100], [100, 0], [0, -100], [-100, 0]]) },

            // ── NBA 2K26 · Turbo / momentum moves (hold RT) ──
            { id: '2k-momentum-btb', name: 'Momentum Behind the Back', group: 'NBA 2K26 · Turbo moves', speed: 1, steps: () => cm2kTurbo(-71, -71, 120) },
            { id: '2k-momentum-stepback', name: 'Momentum Stepback', group: 'NBA 2K26 · Turbo moves', speed: 1, steps: () => cm2kTurbo(0, -100, 120) },

            // ── NBA 2K26 · Shooting ──
            { id: '2k-jumpshot', name: 'Jump Shot ⚠ needs your timing', group: 'NBA 2K26 · Shooting', speed: 1, steps: () => cm2kHold(0, 100, 500) },

            // ── NBA 2K26 · Finishing (RT + Pro Stick) ──
            { id: '2k-dunk-2hand', name: '2-Hand Dunk (RT + up)', group: 'NBA 2K26 · Finishing', speed: 1, steps: () => cm2kTurbo(0, 100, 500) },
            { id: '2k-dunk-flashy', name: 'Flashy Dunk (RT + down)', group: 'NBA 2K26 · Finishing', speed: 1, steps: () => cm2kTurbo(0, -100, 500) },
            { id: '2k-dunk-offhand', name: 'Off-Hand Dunk (RT + side)', group: 'NBA 2K26 · Finishing', speed: 1, steps: () => cm2kTurbo(100, 0, 500) },
            { id: '2k-layup', name: 'Layup (drive + RS up)', group: 'NBA 2K26 · Finishing', speed: 1, steps: () => cm2kHold(0, 100, 400) },
            { id: '2k-floater', name: 'Floater / Runner (RS down)', group: 'NBA 2K26 · Finishing', speed: 1, steps: () => cm2kHold(0, -100, 400) },

            // General movement helper (any game)
            { id: 'hold-forward', name: 'Hold left stick forward', group: 'Basics (any game)', speed: 1, steps: () => [cmLs(0, 100), cmWait(1000), cmLs(0, 0)] }
        ];

        function cmBtnLabel(id, withXb) {
            const meta = CM_BTN_META[id];
            if (!meta) return id;
            return withXb && meta.xb
                ? `<b>${esc(meta.ps)}</b> <span class="text-neutral-600">(${esc(meta.xb)})</span>`
                : `<b>${esc(meta.ps)}</b>`;
        }

        // Rough per-run duration, mirroring compileStepsToEvents timing in main.
        function cmRunDuration(m) {
            let ms = 0;
            for (const s of m.steps || []) {
                if (!s || typeof s !== 'object') continue;
                if (s.t === 'delay') ms += Number(s.ms) || 0;
                else if (s.t === 'tap') ms += 75;
                else ms += 10;
            }
            return ms / (Number(m.speed) > 0 ? Number(m.speed) : 1);
        }

        async function refreshCmData() {
            if (!window.electronAPI?.controllerMacrosGet) return;
            try {
                cmData = await window.electronAPI.controllerMacrosGet();
            } catch (e) {
                console.error('Failed to load controller macros', e);
            }
        }

        // Lets other capture-phase key handlers (spotify-widget type-to-search)
        // bow out while a controller-macro hotkey is being bound.
        function isControllerMacroBinding() {
            return !!cmBindTarget;
        }

        function cmPadConnected() {
            if (!navigator.getGamepads) return false;
            return [...navigator.getGamepads()].some(Boolean);
        }

        async function renderControllerMacrosPanel() {
            const panel = document.getElementById('controller-macros-panel');
            if (!panel) return;
            // Re-rendering replaces innerHTML, which would reset the step list's
            // scroll position on every edit — capture and restore it.
            const scrollEl = cmExpandedId ? document.getElementById(`cm-steps-scroll-${cmExpandedId}`) : null;
            const savedScrollTop = scrollEl ? scrollEl.scrollTop : null;
            await refreshCmData();
            if (!cmData) { panel.innerHTML = ''; return; }

            const d = cmData;
            const busy = d.state !== 'idle' || !!cmRecording;
            const driverOk = d.driver && d.driver.running;
            let html = '';

            // ── Driver status banner ──
            if (!d.clientDll) {
                html += `<div class="mt-3 mb-3 border border-red-500/40 bg-red-500/10 rounded-xl px-3 py-2 text-xs text-red-400">
                    <i class="fas fa-triangle-exclamation mr-1.5"></i>Engine files are missing (main/vendor). Reinstall the app to fix this widget.
                </div>`;
            } else if (!driverOk) {
                const installedNotRunning = d.driver && d.driver.installed;
                html += `<div class="mt-3 mb-3 border border-yellow-500/40 bg-yellow-500/10 rounded-xl px-3 py-2 text-xs">
                    <p class="text-yellow-400 mb-1.5"><i class="fas fa-triangle-exclamation mr-1.5"></i>${installedNotRunning
                        ? 'The ViGEmBus driver is installed but not running — restart Windows, then re-check.'
                        : 'One-time setup: games can only see the virtual controller with the free ViGEmBus driver installed (the same driver DS4Windows uses).'}</p>
                    <div class="flex items-center gap-2">
                        ${installedNotRunning ? '' : `<button type="button" class="hotkey-bind no-drag" onclick="cmOpenDriverPage()"><i class="fas fa-download mr-1.5"></i>Get the driver</button>`}
                        <button type="button" class="hotkey-bind no-drag" onclick="cmRecheckDriver()"><i class="fas fa-rotate mr-1.5"></i>Re-check</button>
                    </div>
                </div>`;
            } else {
                const padName = d.padType === 'ds4' ? 'PlayStation (DualShock 4)' : 'Xbox 360';
                html += `<p class="text-xs text-neutral-500 mt-3 mb-2">
                    <i class="fas fa-circle-check text-emerald-400 mr-1.5"></i>Driver ready — ${d.plugged
                        ? `virtual ${esc(padName)} pad is plugged in`
                        : 'the virtual pad plugs in when the widget is enabled'}.
                </p>`;
            }

            // ── Playing banner ──
            if (d.state === 'playing') {
                const playing = d.macros.find(m => m.id === d.activeMacroId);
                const label = d.activeMacroId === '__preview__' ? 'test steps' : (playing ? playing.name : 'macro');
                html += `<div class="flex items-center justify-between gap-3 mb-3 border border-white/20 bg-white/5 rounded-xl px-3 py-2 text-xs">
                    <span class="text-neutral-300"><i class="fas fa-play mr-1.5"></i>Playing ${esc(label)} — press ${esc(formatHotkeyDisplay(d.toggleHotkey))} to stop</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="stopControllerMacros()">Stop</button>
                </div>`;
            }

            // ── Armed toggle + toggle hotkey + pad type ──
            html += `<div class="flex items-center justify-between gap-3 mb-2">
                <button type="button" class="hotkey-bind no-drag" onclick="toggleCmArmed()" title="Enable or disable all controller macro triggers">
                    <i class="fas ${d.armed ? 'fa-circle-check text-emerald-400' : 'fa-circle-xmark text-neutral-500'} mr-1.5"></i>${d.armed ? 'Macros enabled' : 'Macros disabled'}
                </button>
                <div class="flex items-center gap-2 shrink-0">
                    <span class="text-xs text-neutral-500">toggle key</span>
                    <button type="button" id="cm-toggle-hotkey-btn" class="hotkey-bind no-drag" onclick="startCmHotkeyBind('toggle')">${esc(formatHotkeyDisplay(d.toggleHotkey))}</button>
                </div>
            </div>`;

            html += `<div class="flex items-center gap-2 mb-2">
                <span class="text-xs text-neutral-500 shrink-0">Games see</span>
                <button type="button" class="hotkey-bind no-drag ${d.padType === 'x360' ? 'bg-white/10 text-white' : ''}"
                    title="A virtual Xbox 360 pad — the best compatibility with PC games" onclick="setCmPadType('x360')">
                    <i class="fab fa-xbox mr-1.5"></i>Xbox 360</button>
                <button type="button" class="hotkey-bind no-drag ${d.padType === 'ds4' ? 'bg-white/10 text-white' : ''}"
                    title="A virtual DualShock 4 — games that support it show ✕ □ △ ○ prompts" onclick="setCmPadType('ds4')">
                    <i class="fab fa-playstation mr-1.5"></i>PlayStation</button>
                <span class="text-xs text-neutral-600 truncate">buttons below stay PlayStation-labelled either way</span>
            </div>`;

            if (!d.enabled) {
                html += `<p class="text-xs text-neutral-600 mb-2">Widget disabled — hotkeys are inactive and the virtual pad is unplugged. The ▶ buttons below still work for testing.</p>`;
            } else if (!d.armed) {
                html += `<p class="text-xs text-neutral-600 mb-2">Macros disabled — triggers are off. Press ${esc(formatHotkeyDisplay(d.toggleHotkey))} or click “Macros disabled” to re-enable.</p>`;
            }

            if (!d.macros.length) {
                html += `<p class="text-xs text-neutral-600 my-3">No controller macros yet. Add one and build a combo — e.g. hold L2, tap □, tap ✕.</p>`;
            }

            for (const m of d.macros) {
                const isPlaying = d.state === 'playing' && d.activeMacroId === m.id;
                const expanded = cmExpandedId === m.id;
                const triggerOptions = MACRO_TRIGGERS.map(([value, label]) =>
                    `<option value="${value}" ${m.trigger === value ? 'selected' : ''}>${label}</option>`).join('');
                html += `<div class="border border-white/10 rounded-xl p-3 mb-2 ${m.on ? '' : 'opacity-60'}">
                    <div class="flex items-center gap-2">
                        <input type="checkbox" ${m.on ? 'checked' : ''} onchange="setCmMacroOn(${jsAttr(m.id)}, this.checked)"
                            class="accent-white shrink-0" title="Enable this macro">
                        <input type="text" value="${esc(m.name)}" onchange="renameCmMacro(${jsAttr(m.id)}, this.value)"
                            class="flex-1 min-w-0 bg-transparent border border-transparent hover:border-neutral-700 focus:border-neutral-500 rounded-lg px-2 py-1 text-sm focus:outline-none">
                        <button type="button" id="cm-hotkey-btn-${m.id}" class="hotkey-bind no-drag" title="Trigger — click then press a key or mouse button, Esc while binding to clear"
                            onclick="startCmHotkeyBind('macro', ${jsAttr(m.id)})">${esc(formatMacroHotkey(m.hotkey))}</button>
                        <select class="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:border-neutral-500 shrink-0"
                            title="${esc(MACRO_TRIGGER_HINTS[m.trigger] || '')}" onchange="setCmMacroTrigger(${jsAttr(m.id)}, this.value)">${triggerOptions}</select>
                        ${isPlaying
                            ? `<button type="button" class="hotkey-bind no-drag" title="Stop" onclick="stopControllerMacros()"><i class="fas fa-stop"></i></button>`
                            : `<button type="button" class="hotkey-bind no-drag" title="Play" onclick="playControllerMacro(${jsAttr(m.id)})" ${busy ? 'disabled' : ''}><i class="fas fa-play"></i></button>`}
                        <button type="button" class="hotkey-bind no-drag" title="Edit steps" onclick="toggleCmEditor(${jsAttr(m.id)})"><i class="fas fa-pen"></i></button>
                        <button type="button" class="hotkey-bind no-drag" title="Delete" onclick="deleteCmMacro(${jsAttr(m.id)})"><i class="fas fa-trash"></i></button>
                    </div>
                    ${expanded ? renderCmEditor(m, busy) : ''}
                </div>`;
            }

            html += `<div class="flex items-center justify-between gap-2 mt-2">
                <div class="flex items-center gap-2">
                    <button type="button" class="hotkey-bind no-drag" onclick="addEmptyCmMacro()" ${busy ? 'disabled' : ''}><i class="fas fa-plus mr-1.5"></i>Add macro</button>
                    <button type="button" class="hotkey-bind no-drag ${cmTemplateOpen ? 'listening' : ''}" title="Add a ready-made combo you can tweak" onclick="toggleCmTemplates()" ${busy ? 'disabled' : ''}><i class="fas fa-wand-magic-sparkles mr-1.5"></i>Templates</button>
                </div>
                <span class="text-[10px] text-neutral-700">Anti-cheat titles (e.g. Valorant) may ignore or dislike virtual controllers.</span>
            </div>`;
            if (cmTemplateOpen) html += renderCmTemplatePicker();

            panel.innerHTML = html;
            if (savedScrollTop !== null) {
                const newScrollEl = document.getElementById(`cm-steps-scroll-${cmExpandedId}`);
                if (newScrollEl) newScrollEl.scrollTop = savedScrollTop;
            }
            cmWireStickPad();
        }

        function cmStepBody(m, s, i) {
            const numCls = 'bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-neutral-500 text-center';
            if (s.t === 'delay') {
                return `Wait <input type="number" min="0" max="600000" value="${Number(s.ms) || 0}"
                    onchange="setCmDelay(${jsAttr(m.id)}, ${i}, this.value)" class="w-20 ${numCls}"> ms`;
            }
            if (s.t === 'tap') return `Tap ${cmBtnLabel(s.b, true)}`;
            if (s.t === 'bd') return `Hold ${cmBtnLabel(s.b, true)}`;
            if (s.t === 'bu') return `Release ${cmBtnLabel(s.b, true)}`;
            if (s.t === 'trig') {
                return `Pull ${cmBtnLabel(s.s, true)} to <input type="number" min="0" max="100" value="${Number(s.v) || 0}"
                    onchange="setCmTrigValue(${jsAttr(m.id)}, ${i}, this.value)" class="w-14 ${numCls}">% <span class="text-neutral-600">(0% releases)</span>`;
            }
            if (s.t === 'stick') {
                const name = s.s === 'l' ? 'left stick' : 'right stick';
                return `Move ${name} to x <input type="number" min="-100" max="100" value="${Number(s.x) || 0}"
                        id="cm-stick-x-${m.id}-${i}" onchange="setCmStickValue(${jsAttr(m.id)}, ${i}, 'x', this.value)" class="w-14 ${numCls}">%
                    y <input type="number" min="-100" max="100" value="${Number(s.y) || 0}"
                        id="cm-stick-y-${m.id}-${i}" onchange="setCmStickValue(${jsAttr(m.id)}, ${i}, 'y', this.value)" class="w-14 ${numCls}">%
                    <span class="text-neutral-600">(0 / 0 recentres)</span>`;
            }
            return '?';
        }

        function renderCmEditor(m, busy) {
            let rows = '';
            (m.steps || []).forEach((s, i) => {
                const stickOpen = s.t === 'stick' && cmStickEditFor && cmStickEditFor.id === m.id && cmStickEditFor.index === i;
                const stickBtn = s.t === 'stick'
                    ? `<button type="button" class="hotkey-bind no-drag ${stickOpen ? 'listening' : ''}" title="Pick a direction visually" onclick="toggleCmStickPad(${jsAttr(m.id)}, ${i})"><i class="fas fa-bullseye"></i></button>`
                    : '';
                rows += `<div class="flex items-center gap-2 text-xs text-neutral-400 py-1 border-b border-white/5">
                    <span class="flex-1 min-w-0 truncate flex items-center gap-1.5">${cmStepBody(m, s, i)}</span>
                    ${stickBtn}
                    <button type="button" class="hotkey-bind no-drag" title="Move up" onclick="moveCmStep(${jsAttr(m.id)}, ${i}, -1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Move down" onclick="moveCmStep(${jsAttr(m.id)}, ${i}, 1)" ${i === (m.steps || []).length - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Duplicate this step" onclick="duplicateCmStep(${jsAttr(m.id)}, ${i})"><i class="fas fa-copy"></i></button>
                    <button type="button" class="hotkey-bind no-drag" title="Remove" onclick="removeCmStep(${jsAttr(m.id)}, ${i})"><i class="fas fa-xmark"></i></button>
                </div>`;
                if (stickOpen) rows += renderCmStickPad(m, i, s);
            });
            if (!rows) rows = `<p class="text-xs text-neutral-600 py-1">No steps yet.</p>`;

            const forever = m.repeat === 0;
            const playbackRow = m.trigger === 'hold'
                ? `<span class="text-xs text-neutral-600"><i class="fas fa-hand mr-1"></i>Loops for as long as the key is held</span>`
                : `<span class="text-xs text-neutral-400">Repeat</span>
                    <input type="number" min="1" max="9999" value="${forever ? '' : (m.repeat || 1)}" ${forever ? 'disabled' : ''}
                        onchange="setCmRepeat(${jsAttr(m.id)}, this.value)"
                        class="w-16 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-neutral-500 text-center disabled:opacity-40">
                    <span class="text-xs text-neutral-400">time(s)</span>
                    <label class="flex items-center gap-1.5 cursor-pointer text-xs text-neutral-400">
                        <input type="checkbox" ${forever ? 'checked' : ''} onchange="setCmRepeatForever(${jsAttr(m.id)}, this.checked)" class="accent-white">
                        until stopped
                    </label>`;
            const speedOptions = MACRO_SPEEDS.map((v) =>
                `<option value="${v}" ${Number(m.speed) === v ? 'selected' : ''}>${v}×</option>`).join('');
            const dur = cmRunDuration(m);

            // Recording banner replaces the add-step controls while live.
            const recording = cmRecording && cmRecording.macroId === m.id;
            let controls;
            if (recording) {
                controls = `<div class="flex items-center justify-between gap-3 mt-2 border border-red-500/40 bg-red-500/10 rounded-xl px-3 py-2 text-xs">
                    <span class="text-red-400"><i class="fas fa-circle mr-1.5 animate-pulse"></i>Recording from your controller — press the combo…</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="stopCmPadRecording(true)">Stop &amp; save</button>
                </div>`;
            } else {
                const picker = cmPickerFor && cmPickerFor.id === m.id ? renderCmButtonPicker(m) : '';
                const padHere = cmPadConnected();
                controls = `<div class="flex items-center gap-2 mt-2">
                    <select id="cm-add-step-type-${m.id}" class="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-neutral-500">
                        <option value="tap">Tap a button</option>
                        <option value="bd">Hold a button</option>
                        <option value="bu">Release a button</option>
                        <option value="trig-l2">Pull L2 partially</option>
                        <option value="trig-r2">Pull R2 partially</option>
                        <option value="stick-l">Move left stick</option>
                        <option value="stick-r">Move right stick</option>
                        <option value="delay">Delay</option>
                    </select>
                    <button type="button" class="hotkey-bind no-drag" onclick="addCmStep(${jsAttr(m.id)})">Add step</button>
                    <button type="button" class="hotkey-bind no-drag" title="Play these steps once on the virtual pad" onclick="testCmMacro(${jsAttr(m.id)})" ${busy ? 'disabled' : ''}><i class="fas fa-flask mr-1"></i>Test</button>
                    <button type="button" class="hotkey-bind no-drag" title="${padHere ? 'Record from your controller (replaces these steps)' : 'Connect a controller to record'}"
                        onclick="startCmPadRecording(${jsAttr(m.id)})" ${busy || !padHere ? 'disabled' : ''}>
                        <i class="fas fa-circle mr-1 text-red-400"></i>Record</button>
                    <button type="button" class="hotkey-bind no-drag" title="Clear all steps" onclick="clearCmSteps(${jsAttr(m.id)})" ${(m.steps || []).length ? '' : 'disabled'}><i class="fas fa-eraser"></i></button>
                </div>${picker}`;
            }

            return `<div class="mt-3 pt-2 border-t border-white/10">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                    ${playbackRow}
                    <span class="flex-1"></span>
                    <span class="text-xs text-neutral-400">Speed</span>
                    <select onchange="setCmSpeed(${jsAttr(m.id)}, this.value)"
                        class="bg-neutral-900 border border-neutral-700 rounded-lg px-1.5 py-0.5 text-xs focus:outline-none focus:border-neutral-500">${speedOptions}</select>
                </div>
                <p class="text-xs text-neutral-600 mb-2">${esc(MACRO_TRIGGER_HINTS[m.trigger] || '')}${dur > 0 ? ` · ~${(dur / 1000).toFixed(1)}s per run` : ''}</p>
                <div id="cm-steps-scroll-${m.id}" class="max-h-48 overflow-y-auto pr-1">${rows}</div>
                ${controls}
            </div>`;
        }

        // Inline pad-button picker shown after choosing a Tap/Hold/Release step.
        function renderCmButtonPicker(m) {
            const verb = cmPickerFor.type === 'tap' ? 'tap' : (cmPickerFor.type === 'bd' ? 'hold' : 'release');
            const buttons = CM_BUTTONS.map(([id, ps, xb]) =>
                `<button type="button" class="hotkey-bind no-drag" title="${esc(xb ? `Xbox: ${xb}` : ps)}"
                    onclick="pickCmButton(${jsAttr(m.id)}, ${jsAttr(id)})">${esc(ps)}</button>`).join('');
            return `<div class="border border-white/10 rounded-xl p-2 mt-2">
                <div class="flex items-center justify-between mb-1.5">
                    <span class="text-xs text-neutral-400">Which button should the step ${verb}?</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="cancelCmPicker()"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="flex gap-1.5 flex-wrap">${buttons}</div>
            </div>`;
        }

        // ── Visual joystick pad ──
        // A round drag pad plus a 3×3 direction keypad for a single stick step,
        // so a deflection can be dialled in by feel instead of typing x/y numbers.
        // The knob is positioned from the step's current x/y (+Y up), and drag /
        // preset clicks write straight back through the normal step-save path.
        function renderCmStickPad(m, i, s) {
            const x = Math.max(-100, Math.min(100, Number(s.x) || 0));
            const y = Math.max(-100, Math.min(100, Number(s.y) || 0));
            const knobLeft = 50 + x / 2;   // -100..100 → 0..100 %
            const knobTop = 50 - y / 2;    // +Y up, screen Y down
            const presets = CM_STICK_PRESETS.map((p) =>
                `<button type="button" class="cm-stick-preset no-drag" title="${p.label}"
                    onclick="cmStickPreset(${jsAttr(m.id)}, ${i}, ${p.x}, ${p.y})">${p.icon}</button>`).join('');
            return `<div class="cm-stick-editor" data-cm-stick="${m.id}|${i}">
                <div class="cm-stick-pad no-drag" data-cm-stick-pad>
                    <div class="cm-stick-cross-h"></div>
                    <div class="cm-stick-cross-v"></div>
                    <div class="cm-stick-knob" data-cm-stick-knob style="left:${knobLeft}%;top:${knobTop}%;"></div>
                </div>
                <div class="cm-stick-side">
                    <div class="cm-stick-grid">${presets}</div>
                    <p class="text-[10px] text-neutral-500 mt-1.5">Drag the knob for a custom angle, or tap a direction. Centre (⊙) recentres the stick.</p>
                </div>
            </div>`;
        }

        // Re-attaches the drag handler after every re-render while a pad is open.
        // Dragging updates the knob and the x/y inputs live (no re-render churn),
        // and only commits + saves on release so playback stays smooth.
        function cmWireStickPad() {
            if (!cmStickEditFor) return;
            const pad = document.querySelector('[data-cm-stick-pad]');
            if (!pad) return;
            const knob = pad.querySelector('[data-cm-stick-knob]');
            const { id, index } = cmStickEditFor;
            const readEvent = (ev) => {
                const rect = pad.getBoundingClientRect();
                const r = rect.width / 2;
                let dx = (ev.clientX - (rect.left + r)) / r;
                let dy = (ev.clientY - (rect.top + r)) / r;
                const mag = Math.hypot(dx, dy);
                if (mag > 1) { dx /= mag; dy /= mag; } // clamp to the circular travel
                const nx = Math.round(dx * 100);
                const ny = Math.round(-dy * 100);
                if (knob) { knob.style.left = (50 + nx / 2) + '%'; knob.style.top = (50 - ny / 2) + '%'; }
                cmUpdateStickInputs(id, index, nx, ny);
                cmStickDrag = { id, index, x: nx, y: ny };
            };
            const onMove = (ev) => { ev.preventDefault(); readEvent(ev); };
            const onUp = async () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                if (cmStickDrag) {
                    const d = cmStickDrag;
                    cmStickDrag = null;
                    await cmCommitStick(d.id, d.index, d.x, d.y);
                }
            };
            pad.addEventListener('pointerdown', (ev) => {
                ev.preventDefault();
                readEvent(ev);
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
        }

        function cmUpdateStickInputs(id, index, x, y) {
            const xi = document.getElementById(`cm-stick-x-${id}-${index}`);
            const yi = document.getElementById(`cm-stick-y-${id}-${index}`);
            if (xi) xi.value = x;
            if (yi) yi.value = y;
        }

        async function cmCommitStick(id, index, x, y) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'stick') return;
            m.steps[index].x = Math.max(-100, Math.min(100, Math.round(Number(x) || 0)));
            m.steps[index].y = Math.max(-100, Math.min(100, Math.round(Number(y) || 0)));
            await saveCmMacro(m);
        }

        // Preset tap: set the deflection but keep the pad open for more tweaks.
        async function cmStickPreset(id, index, x, y) {
            await cmCommitStick(id, index, x, y);
        }

        function toggleCmStickPad(id, index) {
            if (cmStickEditFor && cmStickEditFor.id === id && cmStickEditFor.index === index) {
                cmStickEditFor = null;
            } else {
                cmStickEditFor = { id, index };
            }
            renderControllerMacrosPanel();
        }

        function getCmMacro(id) {
            return cmData?.macros.find(m => m.id === id) || null;
        }

        async function saveCmMacro(m) {
            if (!window.electronAPI?.controllerMacrosSave) return;
            const result = await window.electronAPI.controllerMacrosSave(m);
            if (result && result.ok && result.hotkeyOk === false) {
                showToast('Hotkey unavailable — it may belong to the Macros widget', true);
            }
            scheduleSettingsSave();
            await renderControllerMacrosPanel();
        }

        async function renameCmMacro(id, name) {
            const m = getCmMacro(id);
            if (!m) return;
            m.name = (name || '').trim() || m.name;
            await saveCmMacro(m);
        }

        async function setCmMacroOn(id, on) {
            const m = getCmMacro(id);
            if (!m) return;
            m.on = !!on;
            await saveCmMacro(m);
        }

        async function setCmMacroTrigger(id, trigger) {
            const m = getCmMacro(id);
            if (!m) return;
            // Toggle mode usually means "loop until I press the key again".
            if (trigger === 'toggle' && m.repeat === 1) m.repeat = 0;
            m.trigger = trigger;
            await saveCmMacro(m);
        }

        async function setCmRepeat(id, value) {
            const m = getCmMacro(id);
            if (!m) return;
            m.repeat = Math.min(9999, Math.max(1, Math.round(Number(value) || 1)));
            await saveCmMacro(m);
        }

        async function setCmRepeatForever(id, forever) {
            const m = getCmMacro(id);
            if (!m) return;
            m.repeat = forever ? 0 : 1;
            await saveCmMacro(m);
        }

        async function setCmSpeed(id, value) {
            const m = getCmMacro(id);
            if (!m) return;
            m.speed = Number(value) || 1;
            await saveCmMacro(m);
        }

        async function deleteCmMacro(id) {
            if (!window.electronAPI?.controllerMacrosDelete) return;
            await window.electronAPI.controllerMacrosDelete(id);
            if (cmExpandedId === id) cmExpandedId = null;
            scheduleSettingsSave();
            showToast('Controller macro deleted');
            await renderControllerMacrosPanel();
        }

        async function addEmptyCmMacro() {
            await saveCmMacro({ id: null, name: `Combo ${(cmData?.macros.length || 0) + 1}`, hotkey: null, trigger: 'pressed', repeat: 1, speed: 1, on: true, steps: [] });
        }

        // ── Ready-made combos ──
        // Each template's group is "Game · Category" (e.g. "Skate · Flip tricks").
        // The picker shows one game section at a time via tabs, then its categories.
        function cmTemplateGameOf(t) {
            const g = t.group || '';
            const i = g.indexOf(' · ');
            return i > 0 ? g.slice(0, i) : 'General';
        }
        function cmTemplateCategoryOf(t) {
            const g = t.group || '';
            const i = g.indexOf(' · ');
            return i > 0 ? g.slice(i + 3) : (g || 'General');
        }

        function renderCmTemplatePicker() {
            // Split templates into game sections (tabs), preserving list order.
            const gameOrder = [];
            const byGame = new Map();
            for (const t of CM_TEMPLATES) {
                const game = cmTemplateGameOf(t);
                if (!byGame.has(game)) { byGame.set(game, []); gameOrder.push(game); }
                byGame.get(game).push(t);
            }
            const active = cmTemplateGame && byGame.has(cmTemplateGame) ? cmTemplateGame : gameOrder[0];
            const tabs = gameOrder.map((g) =>
                `<button type="button" class="hotkey-bind no-drag ${g === active ? 'bg-white/10 text-white' : ''}"
                    onclick="setCmTemplateGame(${jsAttr(g)})">${esc(g)}</button>`).join('');

            // Within the active game, bucket by category header.
            const catOrder = [];
            const byCat = new Map();
            for (const t of (byGame.get(active) || [])) {
                const c = cmTemplateCategoryOf(t);
                if (!byCat.has(c)) { byCat.set(c, []); catOrder.push(c); }
                byCat.get(c).push(t);
            }
            const sections = catOrder.map((c) => {
                const btns = byCat.get(c).map((t) =>
                    `<button type="button" class="hotkey-bind no-drag" style="flex:1 1 46%;min-width:0;text-align:left;"
                        onclick="addCmTemplate(${jsAttr(t.id)})">${esc(t.name)}</button>`).join('');
                return `<div class="mb-2">
                    <p class="text-[10px] uppercase tracking-wide text-neutral-500 mb-1">${esc(c)}</p>
                    <div class="flex gap-1.5 flex-wrap">${btns}</div>
                </div>`;
            }).join('');

            const hint = active === 'Skate'
                ? 'Classic Flick-It scheme — grabs hold L1 + stick, manuals hold RS halfway. Kickflip/heelflip &amp; FS/BS mirror with your stance.'
                : (active === 'NBA 2K26'
                    ? 'Pro Stick — turbo moves &amp; dunks hold RT. Dribble directions mirror with your ball hand; live moves also depend on left-stick movement.'
                    : 'Handy stick holds that work in any game.');

            return `<div class="border border-white/10 rounded-xl p-2 mt-2">
                <div class="flex items-center justify-between gap-2 mb-1.5">
                    <span class="text-xs text-neutral-400">Pick a move — it becomes a new macro you can tweak.</span>
                    <button type="button" class="hotkey-bind no-drag shrink-0" onclick="toggleCmTemplates()"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="flex gap-1.5 flex-wrap mb-2">${tabs}</div>
                <p class="text-[10px] text-neutral-500 mb-2">${hint}</p>
                <div class="max-h-64 overflow-y-auto pr-1">${sections}</div>
            </div>`;
        }

        function setCmTemplateGame(game) {
            cmTemplateGame = game;
            renderControllerMacrosPanel();
        }

        function toggleCmTemplates() {
            cmTemplateOpen = !cmTemplateOpen;
            renderControllerMacrosPanel();
        }

        async function addCmTemplate(templateId) {
            const t = CM_TEMPLATES.find((x) => x.id === templateId);
            if (!t || !window.electronAPI?.controllerMacrosSave) return;
            cmTemplateOpen = false;
            const steps = typeof t.steps === 'function' ? t.steps() : (t.steps || []);
            const macro = { id: null, name: t.name, hotkey: null, trigger: 'pressed', repeat: 1, speed: t.speed || 1, on: true, steps };
            const result = await window.electronAPI.controllerMacrosSave(macro);
            if (result && result.ok && result.id) {
                cmExpandedId = result.id; // land in the editor with the ready-made steps
                cmStickEditFor = null;
            }
            scheduleSettingsSave();
            showToast(`Added “${t.name}” — tweak the steps to taste`);
            await renderControllerMacrosPanel();
        }

        function toggleCmEditor(id) {
            cmExpandedId = cmExpandedId === id ? null : id;
            cmPickerFor = null;
            cmStickEditFor = null;
            renderControllerMacrosPanel();
        }

        async function playControllerMacro(id) {
            if (!window.electronAPI?.controllerMacrosPlay) return;
            const result = await window.electronAPI.controllerMacrosPlay(id);
            if (result && !result.ok) {
                showToast(result.error === 'empty' ? 'This macro has no steps' : 'Could not start the macro', true);
            }
            await renderControllerMacrosPanel();
        }

        async function testCmMacro(id) {
            const m = getCmMacro(id);
            if (!m || !window.electronAPI?.controllerMacrosPlaySteps) return;
            if (!(m.steps || []).length) { showToast('No steps to test yet', true); return; }
            const result = await window.electronAPI.controllerMacrosPlaySteps(m.steps, m.speed || 1);
            if (result && !result.ok) showToast('Could not start the test', true);
            await renderControllerMacrosPanel();
        }

        async function stopControllerMacros() {
            if (!window.electronAPI?.controllerMacrosStop) return;
            await window.electronAPI.controllerMacrosStop();
        }

        async function toggleCmArmed() {
            const next = !(cmData && cmData.armed);
            const data = await window.electronAPI.controllerMacrosSetArmed(next);
            if (data) cmData = data;
            await renderControllerMacrosPanel();
            showToast(next ? 'Controller macros enabled' : 'Controller macros disabled');
        }

        async function setCmPadType(type) {
            if (!window.electronAPI?.controllerMacrosSetPadType) return;
            const data = await window.electronAPI.controllerMacrosSetPadType(type);
            if (data) cmData = data;
            scheduleSettingsSave();
            await renderControllerMacrosPanel();
        }

        async function cmRecheckDriver() {
            if (!window.electronAPI?.controllerMacrosDriverStatus) return;
            const status = await window.electronAPI.controllerMacrosDriverStatus();
            showToast(status.running ? 'ViGEmBus driver found!' : 'Driver still not detected', !status.running);
            await renderControllerMacrosPanel();
        }

        async function cmOpenDriverPage() {
            if (!window.electronAPI?.controllerMacrosOpenDriverPage) return;
            await window.electronAPI.controllerMacrosOpenDriverPage();
            showToast('Download ViGEmBusSetup from the page that just opened, run it, then Re-check');
        }

        // ── Step editing ──
        async function removeCmStep(id, index) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index]) return;
            m.steps.splice(index, 1);
            cmStickEditFor = null; // indices shifted — close the visual pad
            await saveCmMacro(m);
        }

        async function duplicateCmStep(id, index) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index]) return;
            const copy = JSON.parse(JSON.stringify(m.steps[index]));
            m.steps.splice(index + 1, 0, copy);
            cmStickEditFor = null; // indices shifted — close the visual pad
            await saveCmMacro(m);
            showToast('Step duplicated');
        }

        async function moveCmStep(id, index, delta) {
            const m = getCmMacro(id);
            const j = index + delta;
            if (!m || !m.steps[index] || j < 0 || j >= m.steps.length) return;
            const [s] = m.steps.splice(index, 1);
            m.steps.splice(j, 0, s);
            cmStickEditFor = null; // indices shifted — close the visual pad
            await saveCmMacro(m);
        }

        async function setCmDelay(id, index, value) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'delay') return;
            m.steps[index].ms = Math.min(600000, Math.max(0, Number(value) || 0));
            await saveCmMacro(m);
        }

        async function setCmTrigValue(id, index, value) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'trig') return;
            m.steps[index].v = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
            await saveCmMacro(m);
        }

        async function setCmStickValue(id, index, axis, value) {
            const m = getCmMacro(id);
            if (!m || !m.steps[index] || m.steps[index].t !== 'stick') return;
            m.steps[index][axis] = Math.min(100, Math.max(-100, Math.round(Number(value) || 0)));
            await saveCmMacro(m);
        }

        async function clearCmSteps(id) {
            const m = getCmMacro(id);
            if (!m || !(m.steps || []).length) return;
            m.steps = [];
            cmStickEditFor = null;
            await saveCmMacro(m);
            showToast('Steps cleared');
        }

        async function addCmStep(id) {
            const m = getCmMacro(id);
            const select = document.getElementById(`cm-add-step-type-${id}`);
            if (!m || !select) return;
            const type = select.value;
            if (type === 'delay') {
                m.steps.push({ t: 'delay', ms: 500 });
                await saveCmMacro(m);
            } else if (type === 'trig-l2' || type === 'trig-r2') {
                m.steps.push({ t: 'trig', s: type === 'trig-l2' ? 'l2' : 'r2', v: 50 });
                await saveCmMacro(m);
            } else if (type === 'stick-l' || type === 'stick-r') {
                m.steps.push({ t: 'stick', s: type === 'stick-l' ? 'l' : 'r', x: 0, y: 100 });
                // Drop the user straight onto the visual pad for the new step.
                cmStickEditFor = { id, index: m.steps.length - 1 };
                await saveCmMacro(m);
            } else {
                // tap / bd / bu need a button — open the picker.
                cmPickerFor = { id, type };
                await renderControllerMacrosPanel();
            }
        }

        async function pickCmButton(id, btn) {
            const m = getCmMacro(id);
            const pick = cmPickerFor;
            cmPickerFor = null;
            if (!m || !pick || pick.id !== id) return;
            m.steps.push({ t: pick.type, b: btn });
            await saveCmMacro(m);
        }

        function cancelCmPicker() {
            cmPickerFor = null;
            renderControllerMacrosPanel();
        }

        // ── Recording from a physical controller (Gamepad API) ──
        // Polls the connected pad and turns button/stick activity into steps —
        // the controller equivalent of the Macros widget's input recorder. The
        // Gamepad API is renderer-only, so unlike keyboard recording this needs
        // no engine involvement at all.
        function startCmPadRecording(macroId) {
            if (cmRecording) return;
            const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
            if (!pads.length) { showToast('No controller detected — connect one and press any button', true); return; }
            const pad = pads[0];
            cmRecording = {
                macroId,
                padIndex: pad.index,
                steps: [],
                lastEvT: performance.now(),
                startT: performance.now(),
                prevBtn: {},          // canonical id -> bool
                prevStick: { l: [0, 0], r: [0, 0] },
                lastStickT: { l: 0, r: 0 },
                timer: setInterval(cmPollRecording, 8)
            };
            showToast('Recording — press the combo on your controller, then Stop & save');
            renderControllerMacrosPanel();
        }

        function cmRecPushDelay(now) {
            const gap = now - cmRecording.lastEvT;
            if (gap > 30) cmRecording.steps.push({ t: 'delay', ms: Math.round(gap) });
            cmRecording.lastEvT = now;
        }

        function cmPollRecording() {
            const rec = cmRecording;
            if (!rec) return;
            const pad = navigator.getGamepads ? navigator.getGamepads()[rec.padIndex] : null;
            if (!pad) { stopCmPadRecording(true); showToast('Controller disconnected — recording saved', true); return; }
            const now = performance.now();
            if (now - rec.startT > 120000) { stopCmPadRecording(true); showToast('Recording stopped after 2 minutes'); return; }

            for (let i = 0; i < pad.buttons.length && i < CM_GP_BUTTONS.length; i++) {
                const id = CM_GP_BUTTONS[i];
                const down = !!(pad.buttons[i] && pad.buttons[i].pressed);
                if (down === !!rec.prevBtn[id]) continue;
                rec.prevBtn[id] = down;
                cmRecPushDelay(now);
                rec.steps.push({ t: down ? 'bd' : 'bu', b: id });
            }

            // Sticks: sample meaningful movement (past deadzone, 6% change,
            // throttled) so a flick doesn't become hundreds of steps.
            const axes = pad.axes || [];
            const sticks = { l: [axes[0] || 0, axes[1] || 0], r: [axes[2] || 0, axes[3] || 0] };
            for (const s of ['l', 'r']) {
                let x = Math.round(sticks[s][0] * 100);
                let y = Math.round(-sticks[s][1] * 100); // Gamepad API +Y is down; steps use +Y up
                if (Math.abs(x) < 18) x = 0;
                if (Math.abs(y) < 18) y = 0;
                const [px, py] = rec.prevStick[s];
                const changed = Math.abs(x - px) > 6 || Math.abs(y - py) > 6;
                const recentred = x === 0 && y === 0 && (px !== 0 || py !== 0);
                if ((changed && (now - rec.lastStickT[s] > 80)) || recentred) {
                    rec.prevStick[s] = [x, y];
                    rec.lastStickT[s] = now;
                    cmRecPushDelay(now);
                    rec.steps.push({ t: 'stick', s, x, y });
                }
            }
        }

        async function stopCmPadRecording(save) {
            const rec = cmRecording;
            if (!rec) return;
            clearInterval(rec.timer);
            cmRecording = null;
            if (!save) { await renderControllerMacrosPanel(); return; }
            // Balance any buttons still held so the recording can't leave the
            // virtual pad stuck on playback.
            for (const [id, down] of Object.entries(rec.prevBtn)) {
                if (down) rec.steps.push({ t: 'bu', b: id });
            }
            for (const s of ['l', 'r']) {
                const [px, py] = rec.prevStick[s];
                if (px !== 0 || py !== 0) rec.steps.push({ t: 'stick', s, x: 0, y: 0 });
            }
            if (!rec.steps.some((s) => s.t !== 'delay')) {
                showToast('Recording was empty — steps unchanged', true);
                await renderControllerMacrosPanel();
                return;
            }
            const m = getCmMacro(rec.macroId);
            if (!m) { await renderControllerMacrosPanel(); return; }
            m.steps = rec.steps;
            await saveCmMacro(m);
            showToast('Controller recording saved');
        }

        // Re-render when a pad appears/disappears so the Record button state and
        // its tooltip stay truthful while the editor is open.
        window.addEventListener('gamepadconnected', () => renderControllerMacrosPanel());
        window.addEventListener('gamepaddisconnected', () => renderControllerMacrosPanel());

        // ── Hotkey binding ──
        // Same capture-phase pattern as macros.js (which loads first and yields
        // when it isn't binding). Keyboard keys and mouse buttons both work for
        // per-macro triggers; the enable/disable toggle is keyboard-only.
        async function startCmHotkeyBind(kind, id) {
            if (cmBindTarget || (typeof macrosBindTarget !== 'undefined' && macrosBindTarget) || (typeof bindingTarget !== 'undefined' && bindingTarget)) {
                showToast('Already binding a hotkey. Press Esc to cancel.', true);
                return;
            }
            cmBindTarget = { kind, id };
            await disableAllHotkeys();
            const btn = document.getElementById(kind === 'toggle' ? 'cm-toggle-hotkey-btn' : `cm-hotkey-btn-${id}`);
            if (btn) {
                btn.classList.add('listening');
                btn.textContent = kind === 'toggle' ? 'press key…' : 'press key / mouse…';
            }
            showToast(kind === 'toggle'
                ? 'Press a key combination or Esc to cancel'
                : 'Press a key or mouse button — Esc to clear');
        }

        document.addEventListener('mousedown', async (e) => {
            if (!cmBindTarget) return;
            const name = MACRO_MOUSE_BUTTONS[e.button];
            if (!name) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.button === 2) {
                cmSuppressContextMenu = true;
                setTimeout(() => { cmSuppressContextMenu = false; }, 1000);
            }
            const target = cmBindTarget;
            cmBindTarget = null;
            await enableAllHotkeys();
            if (target.kind === 'toggle') {
                await renderControllerMacrosPanel();
                showToast('The enable/disable hotkey must be a keyboard key', true);
                return;
            }
            const m = getCmMacro(target.id);
            if (m) {
                m.hotkey = name;
                await saveCmMacro(m);
                showToast(`Macro trigger set to ${MACRO_MOUSE_LABELS[name]}`);
            }
            await renderControllerMacrosPanel();
        }, true);

        document.addEventListener('contextmenu', (e) => {
            if (cmSuppressContextMenu) {
                cmSuppressContextMenu = false;
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        document.addEventListener('keydown', async (e) => {
            if (!cmBindTarget) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') {
                const target = cmBindTarget;
                cmBindTarget = null;
                await enableAllHotkeys();
                if (target.kind === 'macro') {
                    const m = getCmMacro(target.id);
                    if (m && m.hotkey) {
                        m.hotkey = null;
                        await saveCmMacro(m);
                        showToast('Hotkey cleared');
                        return;
                    }
                }
                await renderControllerMacrosPanel();
                showToast('Binding cancelled');
                return;
            }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const target = cmBindTarget;
            cmBindTarget = null;
            const electronAccel = toElectronAccelerator(accel);
            if (target.kind === 'toggle') {
                const result = await window.electronAPI.controllerMacrosSetToggleHotkey(electronAccel);
                if (!result?.ok) showToast(result?.error === 'conflict' ? 'That key already triggers a macro' : 'Hotkey unavailable', true);
                else showToast('Enable/disable hotkey updated');
                scheduleSettingsSave();
            } else {
                const m = getCmMacro(target.id);
                if (m) {
                    m.hotkey = electronAccel;
                    await saveCmMacro(m);
                    showToast('Macro hotkey updated');
                }
            }
            await enableAllHotkeys();
            await renderControllerMacrosPanel();
        }, true);

        // Live status pushes from the main process (playback ended, F10 pressed,
        // driver vanished, engine crash, ...).
        if (window.electronAPI?.onControllerMacrosStatus) {
            window.electronAPI.onControllerMacrosStatus((status) => {
                if (!cmData) cmData = { enabled: false, armed: true, toggleHotkey: 'F10', padType: 'x360', plugged: null, driver: { installed: false, running: false }, clientDll: true, state: 'idle', activeMacroId: null, macros: [] };
                cmData.enabled = status.enabled;
                if (typeof status.armed === 'boolean') cmData.armed = status.armed;
                cmData.state = status.state;
                cmData.activeMacroId = status.activeMacroId;
                cmData.padType = status.padType || cmData.padType;
                cmData.plugged = status.plugged;
                if (status.driver) cmData.driver = status.driver;
                if (status.toggleHotkey) cmData.toggleHotkey = status.toggleHotkey;
                if (status?.event === 'driver-missing') {
                    showToast('ViGEmBus driver not found — install it from the Controller Macros panel', true);
                } else if (status?.event === 'engine-crashed') {
                    showToast('Controller engine stopped unexpectedly — recovering', true);
                }
                renderControllerMacrosPanel();
            });
        }
