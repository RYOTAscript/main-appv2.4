        // ── Bass Boost ───────────────────────────────────────────────────────
        // The Widget Library panel: a black-and-white plugin faceplate (knobs,
        // 10-band faders, a live spectrum with the response curve over it).
        // main/bassBoost.js owns the prefs and the audio engine; the curve is
        // drawn with renderer/bass-engine.js — the same maths that builds the
        // filters the engine runs, so what's drawn is what's heard.
        //
        // The faceplate is built ONCE per open and then updated in place — a
        // knob drag must not rebuild the DOM under the pointer. No inline
        // handlers: one delegated listener per event on the panel root, and
        // every piece of device/preset text goes in through textContent.

        let bbState = null;            // last public state from main
        let bbLocal = null;            // prefs as shown (ahead of main while dragging)
        let bbDrag = null;             // { kind, key|index, startY, startV, el }
        let bbPending = null;          // patch waiting for the throttle
        let bbSendTimer = null;
        let bbMeter = null;            // latest spectrum frame
        let bbBars = new Array(32).fill(0);
        let bbCurve = null;            // cached response curve for bbLocal
        let bbDirty = true;
        let bbRaf = 0;
        let bbLastMeterAt = 0;
        let bbBinding = false;
        let bbSaving = false;
        let bbDevicesAsked = false;

        const BB_KNOBS = [
            { key: 'bass', label: 'Bass', unit: 'dB', big: true, reset: 0, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) },
            { key: 'freq', label: 'Freq', unit: 'Hz', reset: 80, step: 1, fmt: (v) => String(Math.round(v)) },
            { key: 'punch', label: 'Punch', unit: 'dB', reset: 0, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) },
            { key: 'harmonics', label: 'Harmonics', unit: '%', reset: 0, step: 1, fmt: (v) => String(Math.round(v)) },
            { key: 'clarity', label: 'Clarity', unit: '%', reset: 0, step: 1, fmt: (v) => String(Math.round(v)) },
            { key: 'output', label: 'Output', unit: 'dB', reset: 0, step: 0.5, bipolar: true, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) }
        ];
        const BB_DB_TOP = 30, BB_DB_BOTTOM = -18;

        function bbEngine() { return window.BassEngine; }

        // Called from applyMiniWidgetPrefs() when the widget toggle flips (and on
        // boot): main binds or drops the hotkey and starts or stops the engine.
        async function applyBassBoostEnabled(enabled) {
            if (!window.electronAPI?.bassSetEnabled) return;
            try {
                const s = await window.electronAPI.bassSetEnabled(!!enabled);
                if (s && s.prefs) bbTakeState(s);
                if (enabled && s && s.hotkeyFailed) showToast('Bass Boost: another app already uses its hotkey — pick another one', true);
            } catch (e) { /* main logs it */ }
            renderBassBoostPanel();
        }

        function bbTakeState(s) {
            if (!s || !s.prefs) return;
            const prev = bbState;
            bbState = s;
            if (!bbDrag) {
                if (!bbLocal || JSON.stringify(bbLocal) !== JSON.stringify(s.prefs)) { bbLocal = s.prefs; bbCurve = null; bbDirty = true; }
            } else {
                // Keep the control under the pointer; take everything else.
                const keep = bbDrag.kind === 'band' ? { bands: bbLocal.bands } : { [bbDrag.key]: bbLocal[bbDrag.key] };
                bbLocal = Object.assign({}, s.prefs, keep);
            }
            if (prev && prev.prefs && prev.prefs.on !== s.prefs.on && s.source === 'hotkey') {
                showToast(s.prefs.on ? 'Bass Boost on' : 'Bass Boost off');
            }
        }

        // ── Panel ──────────────────────────────────────────────────────────────
        async function renderBassBoostPanel() {
            const panel = document.getElementById('bass-boost-panel');
            if (!panel) return;
            const E = bbEngine();
            if (!E || !window.electronAPI?.bassGet) return;
            if (!bbState) {
                try { bbTakeState(await window.electronAPI.bassGet()); } catch (e) { return; }
                if (!bbState || !document.getElementById('bass-boost-panel')) return;
            }
            if (!panel.querySelector('.bb-root')) bbMount(panel);
            bbUpdate(panel);
            bbStartLoop();
            if (!bbDevicesAsked && window.electronAPI.bassDevices) {
                bbDevicesAsked = true;
                window.electronAPI.bassDevices().then((s) => { if (s && s.prefs) { bbTakeState(s); bbUpdate(); } }).catch(() => {});
            }
        }

        function bbMount(panel) {
            const E = bbEngine();
            const knob = (k) =>
                `<div class="bb-knob${k.big ? ' is-big' : ''}${k.bipolar ? ' is-bipolar' : ''}" data-knob="${k.key}" tabindex="0" role="slider" aria-label="${k.label}">` +
                    `<div class="bb-knob-ring"></div>` +
                    `<div class="bb-knob-cap"><span class="bb-knob-tick"></span></div>` +
                    `<div class="bb-knob-read"><span class="bb-knob-val"></span><span class="bb-knob-unit">${k.unit}</span></div>` +
                    `<div class="bb-knob-label">${k.label}</div>` +
                `</div>`;
            const fader = (i) =>
                `<div class="bb-fader" data-band="${i}" tabindex="0" role="slider" aria-label="${E.BAND_LABELS[i]} hertz">` +
                    `<span class="bb-fader-val"></span>` +
                    `<div class="bb-fader-track"><span class="bb-fader-zero"></span><span class="bb-fader-fill"></span><span class="bb-fader-thumb"></span></div>` +
                    `<span class="bb-fader-label">${E.BAND_LABELS[i]}</span>` +
                `</div>`;
            const guards = E.GUARDS.map(g => `<button type="button" class="bb-seg-btn no-drag" data-guard="${g}">${g ? g + ' Hz' : 'Off'}</button>`).join('');

            panel.innerHTML =
                `<div class="bb-root">` +
                    `<div class="bb-plate">` +
                        `<span class="bb-screw is-tl"></span><span class="bb-screw is-tr"></span><span class="bb-screw is-bl"></span><span class="bb-screw is-br"></span>` +
                        `<div class="bb-head">` +
                            `<div class="bb-brand"><span class="bb-led" data-led></span><span class="bb-logo">BASS<i>//</i>BOOST</span><span class="bb-model">main · EQ-24</span></div>` +
                            `<div class="bb-head-tools">` +
                                `<select class="bb-select no-drag" data-preset aria-label="Preset"></select>` +
                                `<button type="button" class="bb-btn no-drag" data-act="save" title="Save as a preset"><i class="fas fa-floppy-disk"></i></button>` +
                                `<button type="button" class="bb-btn no-drag" data-act="delete" title="Delete this preset"><i class="fas fa-trash-can"></i></button>` +
                                `<button type="button" class="bb-btn bb-ab no-drag" data-act="bypass" title="Bypass — hear Spotify without the EQ">A/B</button>` +
                                `<button type="button" class="bb-power no-drag" data-act="power" title="Power (Ctrl+Alt+B)"><i class="fas fa-power-off"></i></button>` +
                            `</div>` +
                        `</div>` +
                        `<div class="bb-saverow hidden" data-saverow>` +
                            `<input class="bb-input no-drag" data-savename maxlength="32" placeholder="Preset name" spellcheck="false">` +
                            `<button type="button" class="bb-btn no-drag" data-act="save-ok">Save</button>` +
                            `<button type="button" class="bb-btn no-drag" data-act="save-cancel">Cancel</button>` +
                        `</div>` +
                        `<div class="bb-screen">` +
                            `<canvas class="bb-canvas" data-canvas></canvas>` +
                            `<div class="bb-screen-read"><span data-preamp></span><span data-latency></span></div>` +
                            `<div class="bb-meters">` +
                                `<div class="bb-meter" title="Bass limiter — how hard it's holding the bass back so the rest stays clear"><div class="bb-meter-bar is-gr" data-gr></div><span>LIM</span></div>` +
                                `<div class="bb-meter" title="Output level"><div class="bb-meter-bar" data-out></div><span>OUT</span></div>` +
                            `</div>` +
                        `</div>` +
                        `<div class="bb-knobs">${BB_KNOBS.map(knob).join('')}</div>` +
                        `<div class="bb-faders">${E.BAND_FREQS.map((_, i) => fader(i)).join('')}</div>` +
                        `<div class="bb-foot">` +
                            `<div class="bb-status" data-status></div>` +
                            `<div class="bb-guard"><span class="bb-foot-label" title="High-pass that keeps sub-bass your speakers can't play from flapping the cones">Speaker guard</span><div class="bb-seg">${guards}</div></div>` +
                        `</div>` +
                    `</div>` +
                    `<div class="fsl-cfg bb-cfg">` +
                        `<div class="fsl-cfg-row"><span class="fsl-cfg-label">Your speakers</span><select class="bb-select is-wide no-drag" data-speaker aria-label="Speaker profile"></select></div>` +
                        `<div class="fsl-cfg-row"><span class="fsl-cfg-label">Play boosted sound on</span><select class="bb-select is-wide no-drag" data-device aria-label="Speakers"></select></div>` +
                        `<div class="fsl-cfg-row"><span class="fsl-cfg-label">Hide Spotify's own sound on</span><select class="bb-select is-wide no-drag" data-sink aria-label="Spare output"></select></div>` +
                        `<div class="fsl-cfg-row"><span class="fsl-cfg-label">Power hotkey</span><div class="sdraw-keys"><span class="sdraw-kbd" data-hotkey></span>` +
                            `<button type="button" class="fsl-seg-btn no-drag" data-act="bind"></button>` +
                            `<button type="button" class="fsl-seg-btn no-drag" data-act="unbind" title="Clear this shortcut"><i class="fas fa-xmark"></i></button></div></div>` +
                        `<p class="fsl-cfg-hint">Only Spotify is boosted. While it's on, Spotify plays on the spare output (muted) and you hear the boosted copy on your speakers, about 40 ms later — too little to notice on music. Spotify's own volume slider still works. ` +
                            `<b>Clarity</b> cuts the muddy range where a big boost buries vocals, and the bass has its own limiter, so a kick never ducks the rest of the song. Pick <b>your speakers</b> and the boost is aimed where they can actually play it. <b>Drag</b> a dial up or down (Shift = fine), <b>scroll</b> to nudge, <b>double-click</b> to reset. ` +
                            `Everything goes back to normal when you switch it off or close main.</p>` +
                    `</div>` +
                `</div>`;

            const root = panel.querySelector('.bb-root');
            root.addEventListener('pointerdown', bbOnPointerDown);
            root.addEventListener('pointermove', bbOnPointerMove);
            root.addEventListener('pointerup', bbOnPointerUp);
            root.addEventListener('pointercancel', bbOnPointerUp);
            root.addEventListener('dblclick', bbOnDblClick);
            root.addEventListener('wheel', bbOnWheel, { passive: false });
            root.addEventListener('keydown', bbOnKey);
            root.addEventListener('click', bbOnClick);
            root.addEventListener('change', bbOnChange);
            bbCurve = null;
            bbDirty = true;
        }

        function bbStatusText(s, p) {
            const st = s.status || {};
            if (st.pending && !p.on) return { cls: 'is-wait', text: 'Putting Spotify’s output back when it next opens' };
            if (!s.widgetEnabled) return { cls: '', text: 'Widget off' };
            if (!p.on) return { cls: '', text: 'Off — power on to boost Spotify' };
            switch (st.state) {
                case 'active': return { cls: 'is-on', text: (p.bypass ? 'Bypassed · ' : 'Boosting Spotify · ') + (st.target || 'speakers') };
                case 'waiting': return { cls: 'is-wait', text: 'Waiting for Spotify to open' };
                case 'nosink': return { cls: 'is-err', text: st.message || 'Needs a second audio output' };
                case 'error': return { cls: 'is-err', text: st.message || 'Something went wrong' };
                default: return { cls: 'is-wait', text: 'Starting…' };
            }
        }

        function bbSetOptions(sel, items, value) {
            const sig = JSON.stringify(items) + '|' + value;
            if (sel.dataset.sig === sig) return;
            sel.dataset.sig = sig;
            sel.textContent = '';
            for (const it of items) {
                const o = document.createElement('option');
                o.value = it.value;
                o.textContent = it.label;
                if (it.disabled) o.disabled = true;
                if (it.group) o.className = 'is-group';
                sel.appendChild(o);
            }
            sel.value = value;
        }

        function bbUpdate(panelArg) {
            const panel = panelArg || document.getElementById('bass-boost-panel');
            const root = panel && panel.querySelector('.bb-root');
            if (!root || !bbState || !bbLocal) return;
            const E = bbEngine();
            const p = bbLocal, s = bbState;

            root.classList.toggle('is-on', !!p.on);
            root.classList.toggle('is-active', !!p.on && s.status && s.status.state === 'active');
            root.classList.toggle('is-bypass', !!p.bypass);
            root.querySelector('[data-act="bypass"]').classList.toggle('is-on', !!p.bypass);

            const presets = E.PRESETS.map(x => ({ value: x.id, label: x.name }));
            const custom = (p.custom || []).map(x => ({ value: x.id, label: '★ ' + x.name }));
            const items = presets.concat(custom);
            if (p.preset === 'custom') items.push({ value: 'custom', label: 'Custom', disabled: true });
            bbSetOptions(root.querySelector('[data-preset]'), items, p.preset);
            root.querySelector('[data-act="delete"]').disabled = !(p.custom || []).some(x => x.id === p.preset);

            for (const k of BB_KNOBS) bbPaintKnob(root, k, p[k.key]);
            for (let i = 0; i < E.BAND_FREQS.length; i++) bbPaintFader(root, i, p.bands[i]);

            root.querySelectorAll('[data-guard]').forEach(b => b.classList.toggle('is-on', Number(b.dataset.guard) === p.guard));

            const st = bbStatusText(s, p);
            const statusEl = root.querySelector('[data-status]');
            statusEl.className = 'bb-status ' + st.cls;
            statusEl.textContent = st.text;

            bbSetOptions(root.querySelector('[data-speaker]'), Object.values(E.SPEAKERS).map(x => ({ value: x.id, label: x.name })), p.speaker);

            const devs = Array.isArray(s.devices) ? s.devices : [];
            const def = devs.find(d => d.default);
            const devItems = [{ value: '', label: 'Windows default' + (def ? ' — ' + def.name : '') }].concat(devs.map(d => ({ value: d.id, label: d.name })));
            if (p.device && !devs.some(d => d.id === p.device)) devItems.push({ value: p.device, label: 'Saved device (not connected)' });
            bbSetOptions(root.querySelector('[data-device]'), devItems, p.device || '');
            const sinkItems = [{ value: '', label: 'Automatic' + (s.status && s.status.sink ? ' — ' + s.status.sink : '') }].concat(devs.map(d => ({ value: d.id, label: d.name })));
            if (p.sink && !devs.some(d => d.id === p.sink)) sinkItems.push({ value: p.sink, label: 'Saved output (not connected)' });
            bbSetOptions(root.querySelector('[data-sink]'), sinkItems, p.sink || '');

            const hk = root.querySelector('[data-hotkey]');
            hk.textContent = bbBinding ? 'Press a shortcut…' : bbHotkeyText(p.hotkey);
            hk.classList.toggle('is-listening', bbBinding);
            root.querySelector('[data-act="bind"]').textContent = bbBinding ? 'Cancel' : 'Set';
            root.querySelector('[data-act="unbind"]').classList.toggle('hidden', !p.hotkey || bbBinding);

            const pre = E.preampDb(p);
            root.querySelector('[data-preamp]').textContent = p.bypass ? 'BYPASS' : (pre < -0.05 ? 'AUTO-PROTECT ' + pre.toFixed(1) + ' dB' : 'AUTO-PROTECT 0 dB');
            bbDirty = true;
        }

        function bbHotkeyText(accel) {
            if (!accel) return 'Not set';
            const raw = accel.replace(/CommandOrControl/g, 'Control');
            return typeof formatHotkeyDisplay === 'function' ? formatHotkeyDisplay(raw) : raw;
        }

        function bbLimits(key) {
            if (key === 'bass' && bbLocal) return bbEngine().bassRange(bbLocal);
            const L = bbEngine().LIMITS;
            return L[key] || L.band;
        }

        function bbPaintKnob(root, k, v) {
            const el = root.querySelector(`[data-knob="${k.key}"]`);
            if (!el) return;
            const [lo, hi] = bbLimits(k.key);
            const t = (v - lo) / (hi - lo);
            let s = 0, e = t;
            if (k.bipolar) { const z = (0 - lo) / (hi - lo); s = Math.min(z, t); e = Math.max(z, t); }
            el.style.setProperty('--s', s.toFixed(4));
            el.style.setProperty('--e', e.toFixed(4));
            el.style.setProperty('--a', (-135 + t * 270).toFixed(1) + 'deg');
            el.querySelector('.bb-knob-val').textContent = k.fmt(v);
            el.setAttribute('aria-valuenow', String(v));
        }

        function bbPaintFader(root, i, v) {
            const el = root.querySelector(`[data-band="${i}"]`);
            if (!el) return;
            const [lo, hi] = bbLimits('band');
            const t = (v - lo) / (hi - lo);
            el.style.setProperty('--t', t.toFixed(4));
            el.style.setProperty('--f0', Math.min(t, 0.5).toFixed(4));
            el.style.setProperty('--f1', Math.max(t, 0.5).toFixed(4));
            el.querySelector('.bb-fader-val').textContent = (v > 0 ? '+' : '') + (Math.round(v * 2) / 2).toFixed(1);
            el.setAttribute('aria-valuenow', String(v));
        }

        // ── Changing values ────────────────────────────────────────────────────
        function bbSet(kind, key, value) {
            const E = bbEngine();
            if (kind === 'band') bbLocal = E.applyPatch(bbLocal, { band: { index: key, value } });
            else bbLocal = E.applyPatch(bbLocal, { [key]: value });
            bbCurve = null;
            bbDirty = true;
            const root = document.querySelector('#bass-boost-panel .bb-root');
            if (root) {
                if (kind === 'band') bbPaintFader(root, key, bbLocal.bands[key]);
                else bbPaintKnob(root, BB_KNOBS.find(k => k.key === key), bbLocal[key]);
                bbUpdate();
            }
            bbQueue(kind === 'band' ? { bands: bbLocal.bands } : { [key]: bbLocal[key] });
        }

        function bbQueue(patch) {
            bbPending = Object.assign(bbPending || {}, patch);
            if (bbSendTimer) return;
            bbSendTimer = setTimeout(bbFlush, 40);
        }

        function bbFlush() {
            bbSendTimer = null;
            const patch = bbPending;
            bbPending = null;
            if (!patch || !window.electronAPI?.bassSetPrefs) return;
            window.electronAPI.bassSetPrefs(patch).then((s) => {
                if (s && s.prefs) { bbTakeState(s); if (!bbDrag) bbUpdate(); }
            }).catch(() => {});
        }

        async function bbCall(fn, ...args) {
            if (!window.electronAPI || typeof window.electronAPI[fn] !== 'function') return null;
            try {
                const s = await window.electronAPI[fn](...args);
                if (s && s.prefs) { bbTakeState(s); bbUpdate(); }
                return s;
            } catch (e) { return null; }
        }

        function bbTargetOf(e) {
            const knob = e.target.closest && e.target.closest('[data-knob]');
            if (knob) return { kind: 'knob', key: knob.dataset.knob, el: knob };
            const fader = e.target.closest && e.target.closest('[data-band]');
            if (fader) return { kind: 'band', key: Number(fader.dataset.band), el: fader };
            return null;
        }

        function bbValueOf(t) { return t.kind === 'band' ? bbLocal.bands[t.key] : bbLocal[t.key]; }

        function bbFaderValueAt(el, clientY) {
            const track = el.querySelector('.bb-fader-track').getBoundingClientRect();
            const [lo, hi] = bbLimits('band');
            const t = 1 - Math.min(1, Math.max(0, (clientY - track.top) / track.height));
            return Math.round((lo + t * (hi - lo)) * 2) / 2;
        }

        function bbOnPointerDown(e) {
            if (e.button !== 0) return;
            const t = bbTargetOf(e);
            if (!t || !bbLocal) return;
            e.preventDefault();
            t.el.setPointerCapture(e.pointerId);
            t.el.classList.add('is-drag');
            bbDrag = Object.assign(t, { startY: e.clientY, startV: bbValueOf(t) });
            if (t.kind === 'band') bbSet('band', t.key, bbFaderValueAt(t.el, e.clientY));
        }

        function bbOnPointerMove(e) {
            if (!bbDrag) return;
            if (bbDrag.kind === 'band') { bbSet('band', bbDrag.key, bbFaderValueAt(bbDrag.el, e.clientY)); return; }
            const [lo, hi] = bbLimits(bbDrag.key);
            const k = BB_KNOBS.find(x => x.key === bbDrag.key);
            const span = e.shiftKey ? 900 : 180;
            let v = bbDrag.startV + (bbDrag.startY - e.clientY) / span * (hi - lo);
            v = Math.min(hi, Math.max(lo, Math.round(v / k.step) * k.step));
            if (v !== bbLocal[bbDrag.key]) bbSet('knob', bbDrag.key, v);
        }

        function bbOnPointerUp() {
            if (!bbDrag) return;
            bbDrag.el.classList.remove('is-drag');
            bbDrag = null;
            if (bbSendTimer) { clearTimeout(bbSendTimer); bbFlush(); }
        }

        function bbOnDblClick(e) {
            const t = bbTargetOf(e);
            if (!t) return;
            if (t.kind === 'band') bbSet('band', t.key, 0);
            else bbSet('knob', t.key, BB_KNOBS.find(k => k.key === t.key).reset);
        }

        function bbNudge(t, dir, fine) {
            if (t.kind === 'band') {
                const v = Math.min(12, Math.max(-12, bbLocal.bands[t.key] + dir * (fine ? 0.5 : 1)));
                bbSet('band', t.key, v);
                return;
            }
            const k = BB_KNOBS.find(x => x.key === t.key);
            const [lo, hi] = bbLimits(t.key);
            const step = fine ? k.step : (k.key === 'freq' || k.key === 'harmonics' || k.key === 'clarity' ? 5 : 1);
            bbSet('knob', t.key, Math.min(hi, Math.max(lo, bbLocal[t.key] + dir * step)));
        }

        function bbOnWheel(e) {
            const t = bbTargetOf(e);
            if (!t || !bbLocal) return;
            e.preventDefault();
            bbNudge(t, e.deltaY < 0 ? 1 : -1, e.shiftKey);
        }

        function bbOnKey(e) {
            if (e.target.matches && e.target.matches('[data-savename]')) {
                if (e.key === 'Enter') { e.preventDefault(); bbSavePreset(); }
                return;
            }
            const t = bbTargetOf(e);
            if (!t || !bbLocal) return;
            const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
            if (!(e.key in map)) return;
            e.preventDefault();
            bbNudge(t, map[e.key], e.shiftKey);
        }

        function bbOnClick(e) {
            const btn = e.target.closest && e.target.closest('button');
            if (!btn || !bbLocal) return;
            if (btn.dataset.guard !== undefined) { bbCall('bassSetPrefs', { guard: Number(btn.dataset.guard) }); return; }
            switch (btn.dataset.act) {
                case 'power': bbCall('bassSetPower', !bbLocal.on); break;
                case 'bypass': bbCall('bassSetPrefs', { bypass: !bbLocal.bypass }); break;
                case 'save': bbToggleSave(true); break;
                case 'save-ok': bbSavePreset(); break;
                case 'save-cancel': bbToggleSave(false); break;
                case 'delete': bbCall('bassDeletePreset', bbLocal.preset); break;
                case 'bind': if (bbBinding) bbEndBind(); else bbBeginBind(); break;
                case 'unbind': bbCall('bassSetPrefs', { hotkey: '' }); break;
            }
        }

        function bbOnChange(e) {
            const el = e.target;
            if (el.matches('[data-preset]')) bbCall('bassSetPrefs', { preset: el.value });
            else if (el.matches('[data-speaker]')) bbCall('bassSetPrefs', { speaker: el.value });
            else if (el.matches('[data-device]')) bbCall('bassSetPrefs', { device: el.value });
            else if (el.matches('[data-sink]')) bbCall('bassSetPrefs', { sink: el.value });
        }

        function bbToggleSave(show) {
            const root = document.querySelector('#bass-boost-panel .bb-root');
            if (!root) return;
            bbSaving = !!show;
            const row = root.querySelector('[data-saverow]');
            row.classList.toggle('hidden', !show);
            const input = root.querySelector('[data-savename]');
            if (show) { input.value = ''; input.focus(); }
        }

        async function bbSavePreset() {
            const input = document.querySelector('#bass-boost-panel [data-savename]');
            const name = input ? input.value.trim() : '';
            if (!name) { showToast('Give the preset a name', true); return; }
            const s = await bbCall('bassSavePreset', name);
            if (s && s.error) { showToast(s.error, true); return; }
            bbToggleSave(false);
            showToast(`Saved “${name}”`);
        }

        // ── Recording the hotkey (same rules as Draw on Screen) ────────────────
        async function bbBeginBind() {
            if (bbBinding || (typeof bindingTarget !== 'undefined' && bindingTarget)) return;
            bbBinding = true;
            if (typeof disableAllHotkeys === 'function') await disableAllHotkeys();
            window.addEventListener('keydown', bbBindListener, true);
            bbUpdate();
            showToast('Press a shortcut — Esc to cancel');
        }

        async function bbEndBind() {
            window.removeEventListener('keydown', bbBindListener, true);
            bbBinding = false;
            if (typeof enableAllHotkeys === 'function') await enableAllHotkeys();
            bbUpdate();
        }

        async function bbBindListener(e) {
            if (!bbBinding) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            if (e.key === 'Escape') { await bbEndBind(); showToast('Cancelled'); return; }
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const isFKey = /^F\d{1,2}$/.test(accel.split('+').pop());
            if (!isFKey && !(e.ctrlKey || e.altKey || e.metaKey)) { showToast('Use Ctrl or Alt with a key — or an F-key', true); return; }
            const electronAccel = toElectronAccelerator(accel);
            const takenInApp = typeof hotkeys === 'object' && hotkeys && Object.values(hotkeys).includes(accel);
            await bbEndBind();
            if (takenInApp) { showToast('That shortcut is already used in main', true); return; }
            const s = await bbCall('bassSetPrefs', { hotkey: electronAccel });
            if (s && s.hotkeyFailed) {
                showToast('Another app already uses that shortcut', true);
                await bbCall('bassSetPrefs', { hotkey: '' });
                return;
            }
            showToast(`Bass Boost: ${bbHotkeyText(electronAccel)}`);
        }

        // ── The screen: spectrum + response curve ──────────────────────────────
        // Runs only while the panel is on screen; the moment its div is gone the
        // loop stops and main is told to stop streaming spectrum frames.
        function bbStartLoop() {
            if (bbRaf) return;
            if (window.electronAPI?.bassMeter) window.electronAPI.bassMeter(true).catch(() => {});
            bbRaf = requestAnimationFrame(bbFrame);
        }

        function bbStopLoop() {
            if (bbRaf) cancelAnimationFrame(bbRaf);
            bbRaf = 0;
            bbMeter = null;
            bbBars.fill(0);
            bbDevicesAsked = false;
            if (bbBinding) bbEndBind();
            if (window.electronAPI?.bassMeter) window.electronAPI.bassMeter(false).catch(() => {});
        }

        function bbFrame(now) {
            const canvas = document.querySelector('#bass-boost-panel [data-canvas]');
            if (!canvas || !canvas.isConnected) { bbRaf = 0; bbStopLoop(); return; }
            bbRaf = requestAnimationFrame(bbFrame);
            const live = bbMeter && now - bbLastMeterAt < 400;
            let moving = false;
            for (let i = 0; i < bbBars.length; i++) {
                const target = live ? bbMeter.bands[i] : 0;
                const next = target > bbBars[i] ? target : Math.max(target, bbBars[i] - 0.018);
                if (Math.abs(next - bbBars[i]) > 0.0005) moving = true;
                bbBars[i] = next;
            }
            if (!moving && !bbDirty) return;
            bbDirty = false;
            bbDraw(canvas);
        }

        function bbDraw(canvas) {
            const E = bbEngine();
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (!w || !h) return;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            const g = canvas.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);
            const padB = 14;
            const ph = h - padB;
            const x = (f) => Math.log(f / 20) / Math.log(1000) * w;
            const y = (db) => (BB_DB_TOP - db) / (BB_DB_TOP - BB_DB_BOTTOM) * ph;

            // Grid
            g.lineWidth = 1;
            g.font = '9px "JetBrains Mono", monospace';
            g.textBaseline = 'top';
            for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
                const xx = Math.round(x(f)) + 0.5;
                g.strokeStyle = 'rgba(255,255,255,0.05)';
                g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, ph); g.stroke();
                g.fillStyle = 'rgba(255,255,255,0.28)';
                g.fillText(E.formatFreq(f), xx + 3, ph + 3);
            }
            for (let db = BB_DB_BOTTOM; db <= BB_DB_TOP; db += 6) {
                const yy = Math.round(y(db)) + 0.5;
                g.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
                g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
                if (db !== BB_DB_TOP) {
                    g.fillStyle = 'rgba(255,255,255,0.28)';
                    g.fillText((db > 0 ? '+' : '') + db, 4, yy + 2);
                }
            }

            // Spectrum (what's actually coming out)
            const n = bbBars.length;
            for (let i = 0; i < n; i++) {
                const v = bbBars[i];
                if (v <= 0.002) continue;
                const x0 = x(20 * Math.pow(1000, i / n)), x1 = x(20 * Math.pow(1000, (i + 1) / n));
                const bh = v * ph;
                const grd = g.createLinearGradient(0, ph - bh, 0, ph);
                grd.addColorStop(0, 'rgba(255,255,255,0.34)');
                grd.addColorStop(1, 'rgba(255,255,255,0.04)');
                g.fillStyle = grd;
                g.fillRect(x0 + 1, ph - bh, Math.max(1, x1 - x0 - 2), bh);
                g.fillStyle = 'rgba(255,255,255,0.7)';
                g.fillRect(x0 + 1, ph - bh, Math.max(1, x1 - x0 - 2), 1);
            }

            // Response curve (what the EQ is set to)
            if (!bbCurve) bbCurve = E.responseCurve(bbLocal, 180);
            const pts = bbCurve;
            g.beginPath();
            pts.forEach((pt, i) => { const xx = x(pt.f), yy = y(Math.max(BB_DB_BOTTOM - 2, Math.min(BB_DB_TOP + 2, pt.db))); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
            if (!bbLocal.bypass) {
                g.save();
                g.lineTo(w, y(0)); g.lineTo(0, y(0)); g.closePath();
                const fill = g.createLinearGradient(0, y(BB_DB_TOP), 0, y(0));
                fill.addColorStop(0, 'rgba(255,255,255,0.22)');
                fill.addColorStop(1, 'rgba(255,255,255,0.02)');
                g.fillStyle = fill;
                g.fill();
                g.restore();
                g.beginPath();
                pts.forEach((pt, i) => { const xx = x(pt.f), yy = y(Math.max(BB_DB_BOTTOM - 2, Math.min(BB_DB_TOP + 2, pt.db))); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
            }
            g.save();
            g.setLineDash(bbLocal.bypass ? [4, 4] : []);
            g.strokeStyle = bbLocal.bypass ? 'rgba(255,255,255,0.35)' : '#fff';
            g.lineWidth = 2;
            g.shadowColor = 'rgba(255,255,255,0.6)';
            g.shadowBlur = bbLocal.bypass ? 0 : 8;
            g.stroke();
            g.restore();

            // A handle on the BASS frequency
            if (!bbLocal.bypass && bbLocal.bass > 0) {
                const fx = x(bbLocal.freq);
                let peak = 0;
                for (const pt of pts) if (pt.f <= bbLocal.freq * 1.05) peak = pt.db;
                g.fillStyle = '#000';
                g.strokeStyle = '#fff';
                g.lineWidth = 1.5;
                g.beginPath(); g.arc(fx, y(Math.min(BB_DB_TOP, peak)), 4, 0, Math.PI * 2); g.fill(); g.stroke();
            }
        }

        function bbOnMeter(m) {
            if (!m || !Array.isArray(m.bands)) return;
            bbMeter = m;
            bbLastMeterAt = performance.now();
            const root = document.querySelector('#bass-boost-panel .bb-root');
            if (!root) return;
            const gr = root.querySelector('[data-gr]');
            const out = root.querySelector('[data-out]');
            if (gr) gr.style.transform = `scaleY(${Math.min(1, Math.max(m.reductionDb, m.bassReductionDb || 0) / 12).toFixed(3)})`;
            if (out) out.style.transform = `scaleY(${Math.min(1, m.peak).toFixed(3)})`;
            const lat = root.querySelector('[data-latency]');
            if (lat) lat.textContent = m.latencyMs ? `${m.latencyMs} ms` : '';
        }

        if (window.electronAPI?.onBassChanged) {
            window.electronAPI.onBassChanged((s) => {
                if (!s || !s.prefs) return;
                bbTakeState(s);
                if (!bbDrag) bbUpdate();
            });
        }
        if (window.electronAPI?.onBassMeter) window.electronAPI.onBassMeter(bbOnMeter);

        // ── Voice assistant hooks (renderer/voice-assistant.js) ────────────────
        async function bassBoostVoicePower(on) {
            if (!window.electronAPI?.bassSetPower) return { ok: false, message: 'Bass Boost isn’t available' };
            if (typeof isMiniWidgetEnabled === 'function' && !isMiniWidgetEnabled('bassBoost')) return { ok: false, message: 'Bass Boost widget is off' };
            const s = await window.electronAPI.bassSetPower(!!on);
            if (s && s.prefs) { bbTakeState(s); bbUpdate(); }
            return { ok: true };
        }

        async function bassBoostVoiceNudge(deltaDb) {
            if (!window.electronAPI?.bassNudge) return { ok: false, message: 'Bass Boost isn’t available' };
            if (typeof isMiniWidgetEnabled === 'function' && !isMiniWidgetEnabled('bassBoost')) return { ok: false, message: 'Bass Boost widget is off' };
            const s = await window.electronAPI.bassNudge(deltaDb);
            if (!s || !s.prefs) return { ok: false, message: 'Bass Boost didn’t respond' };
            bbTakeState(s);
            bbUpdate();
            return { ok: true, message: `Bass ${s.prefs.bass > 0 ? '+' : ''}${s.prefs.bass} dB` };
        }

        async function bassBoostVoicePreset(id) {
            if (!window.electronAPI?.bassSetPrefs) return { ok: false, message: 'Bass Boost isn’t available' };
            if (typeof isMiniWidgetEnabled === 'function' && !isMiniWidgetEnabled('bassBoost')) return { ok: false, message: 'Bass Boost widget is off' };
            const s = await window.electronAPI.bassSetPrefs({ preset: id, on: true, bypass: false });
            if (s && s.prefs) { bbTakeState(s); bbUpdate(); }
            return { ok: true };
        }
