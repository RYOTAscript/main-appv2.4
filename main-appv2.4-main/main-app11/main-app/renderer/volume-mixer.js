        // ── Volume Mixer mini widget (renderer) ──
        // Per-app volume sliders + master volume, like the Windows tray mixer, plus
        // optional global hotkeys for master volume up/down/mute. The main process
        // (main/volumeMixer.js) owns the Core Audio helper; this panel just renders
        // its session list and forwards slider/mute changes. The panel div only
        // exists while the detail view is open, so every render no-ops without it.

        let volMixData = null;          // last { master, sessions } from main
        let volMixPoll = null;          // interval that refreshes while the panel is open
        let volMixHotkeys = null;       // { volUp, volDown, volMute }
        let volMixBinding = null;       // which hotkey is currently capturing, or null
        let volMixChangedHooked = false;
        let volMixDragging = false;     // suppress polling repaint mid-drag

        function isVolMixEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.volumeMixer;
        }

        async function applyVolumeMixerEnabled(enabled) {
            if (window.electronAPI?.volumeMixerSetEnabled) {
                await window.electronAPI.volumeMixerSetEnabled(!!enabled);
            }
            if (typeof renderVolumeMixerPanel === 'function') renderVolumeMixerPanel();
        }

        function hookVolMixChanged() {
            if (volMixChangedHooked || !window.electronAPI?.onVolumeMixerChanged) return;
            volMixChangedHooked = true;
            window.electronAPI.onVolumeMixerChanged(() => {
                // A hotkey moved the master volume — refresh if the panel is showing.
                if (document.getElementById('volume-mixer-panel')) volMixRefresh();
            });
        }

        async function renderVolumeMixerPanel() {
            const panel = document.getElementById('volume-mixer-panel');
            stopVolMixPoll();
            if (!panel) return;
            hookVolMixChanged();
            if (!isVolMixEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.volumeMixerList) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Volume control is unavailable.</p>`;
                return;
            }
            panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3"><i class="fas fa-circle-notch fa-spin mr-1.5"></i>Reading audio sessions…</p>`;
            if (!volMixHotkeys && window.electronAPI?.volumeMixerGetHotkeys) {
                volMixHotkeys = await window.electronAPI.volumeMixerGetHotkeys();
            }
            const res = await window.electronAPI.volumeMixerList();
            if (!isVolMixEnabled() || !document.getElementById('volume-mixer-panel')) return;
            if (!res || !res.ok) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Couldn't read audio sessions.
                    <button type="button" class="hotkey-bind no-drag ml-2" onclick="renderVolumeMixerPanel()">Retry</button></p>`;
                return;
            }
            volMixData = res;
            volMixPaint();
            startVolMixPoll();
        }

        // Lightweight refresh (no spinner) used by the poll timer and change events.
        async function volMixRefresh() {
            if (!isVolMixEnabled() || volMixBinding || volMixDragging) return;
            if (!window.electronAPI?.volumeMixerList) return;
            const res = await window.electronAPI.volumeMixerList();
            if (!res || !res.ok || !document.getElementById('volume-mixer-panel')) return;
            volMixData = res;
            volMixPaint();
        }

        function startVolMixPoll() {
            stopVolMixPoll();
            volMixPoll = setInterval(volMixRefresh, 2000);
        }
        function stopVolMixPoll() {
            if (volMixPoll) { clearInterval(volMixPoll); volMixPoll = null; }
        }

        function volMixIcon(name, system) {
            if (system) return 'fa-volume-high';
            const n = (name || '').toLowerCase();
            if (n.includes('spotify')) return 'fa-spotify';
            if (n.includes('discord')) return 'fa-discord';
            if (n.includes('chrome') || n.includes('msedge') || n.includes('firefox')) return 'fa-globe';
            return 'fa-window-maximize';
        }

        function volMixRow(kind, id, name, icon, iconStyle, volume, muted) {
            const vol = Math.max(0, Math.min(100, Math.round(volume)));
            return `<div class="vol-mix-row">
                <button type="button" class="vol-mix-mute no-drag ${muted ? 'muted' : ''}"
                    onclick="volMixToggleMute(${jsAttr(kind)}, ${id}, ${!muted})" title="${muted ? 'Unmute' : 'Mute'}">
                    <i class="${iconStyle || 'fas'} ${muted ? 'fa-volume-xmark' : icon}"></i>
                </button>
                <div class="vol-mix-body">
                    <div class="flex items-center justify-between gap-2">
                        <span class="vol-mix-name">${esc(name)}</span>
                        <span class="vol-mix-pct" id="vol-mix-pct-${kind}-${id}">${vol}%</span>
                    </div>
                    <input type="range" min="0" max="100" value="${vol}" class="vol-mix-slider no-drag ${muted ? 'is-muted' : ''}"
                        oninput="volMixOnInput(${jsAttr(kind)}, ${id}, this.value)"
                        onpointerdown="volMixDragging=true" onpointerup="volMixDragging=false" onpointercancel="volMixDragging=false"
                        onchange="volMixOnChange(${jsAttr(kind)}, ${id}, this.value)">
                </div>
            </div>`;
        }

        function volMixPaint() {
            const panel = document.getElementById('volume-mixer-panel');
            if (!panel || !volMixData) return;
            const master = volMixData.master || { volume: 50, muted: false };
            const sessions = (volMixData.sessions || []).slice().sort((a, b) => {
                if (!!a.system !== !!b.system) return a.system ? 1 : -1; // system sounds last
                return (a.name || '').localeCompare(b.name || '');
            });

            const masterRow = volMixRow('master', 0, 'Master volume', 'fa-volume-high', 'fas', master.volume, master.muted);
            const appRows = sessions.length
                ? sessions.map(s => volMixRow('app', s.pid, s.name, volMixIcon(s.name, s.system),
                    (volMixIcon(s.name, s.system) === 'fa-spotify' || volMixIcon(s.name, s.system) === 'fa-discord') ? 'fab' : 'fas',
                    s.volume, s.muted)).join('')
                : `<p class="text-xs text-neutral-600 py-2">No apps are playing audio right now.</p>`;

            panel.innerHTML = `
                <div class="mt-3 space-y-3">
                    <div class="vol-mix-master">${masterRow}</div>
                    <div>
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-[10px] uppercase tracking-widest text-neutral-600">Applications</span>
                            <button type="button" class="hotkey-bind no-drag" onclick="renderVolumeMixerPanel()"><i class="fas fa-rotate-right mr-1"></i>Refresh</button>
                        </div>
                        <div class="space-y-2">${appRows}</div>
                    </div>
                    <div class="border-t border-white/10 pt-3">
                        <p class="text-[10px] uppercase tracking-widest text-neutral-600 mb-2">Master volume hotkeys</p>
                        <div class="grid grid-cols-3 gap-2">
                            ${volMixHotkeyBtn('volUp', 'Volume up')}
                            ${volMixHotkeyBtn('volDown', 'Volume down')}
                            ${volMixHotkeyBtn('volMute', 'Mute')}
                        </div>
                        <p class="text-[10px] text-neutral-600 mt-2">Click a slot, then press a key combo. Press Esc to clear.</p>
                    </div>
                </div>`;
        }

        function volMixHotkeyBtn(which, label) {
            const hk = (volMixHotkeys && volMixHotkeys[which]) || '';
            const binding = volMixBinding === which;
            const text = binding ? 'press key…' : (hk ? formatHotkeyDisplay(hk) : 'Set');
            return `<div class="text-center">
                <p class="text-[10px] text-neutral-500 mb-1">${esc(label)}</p>
                <button type="button" class="hotkey-bind w-full no-drag ${binding ? 'listening' : ''}"
                    onclick="volMixStartBind(${jsAttr(which)})">${esc(text)}</button>
            </div>`;
        }

        function volMixOnInput(kind, id, value) {
            const pct = document.getElementById(`vol-mix-pct-${kind}-${id}`);
            if (pct) pct.textContent = `${value}%`;
            // Live-apply while dragging for immediate feedback.
            volMixApplyVolume(kind, id, value);
        }

        function volMixOnChange(kind, id, value) {
            volMixDragging = false;
            volMixApplyVolume(kind, id, value);
        }

        let volMixApplyThrottle = {};
        function volMixApplyVolume(kind, id, value) {
            const v = Math.round(Number(value));
            const key = `${kind}-${id}`;
            // Throttle rapid slider events to ~every 40ms per row.
            const now = Date.now();
            if (volMixApplyThrottle[key] && now - volMixApplyThrottle[key] < 40) return;
            volMixApplyThrottle[key] = now;
            if (kind === 'master') {
                window.electronAPI?.volumeMixerSetMaster?.(v);
            } else {
                window.electronAPI?.volumeMixerSetApp?.(id, v);
            }
        }

        function volMixToggleMute(kind, id, mute) {
            if (kind === 'master') window.electronAPI?.volumeMixerMuteMaster?.(mute);
            else window.electronAPI?.volumeMixerMuteApp?.(id, mute);
            // Reflect immediately, then let the next poll confirm.
            if (volMixData) {
                if (kind === 'master' && volMixData.master) volMixData.master.muted = mute;
                else {
                    const s = (volMixData.sessions || []).find(x => x.pid === id);
                    if (s) s.muted = mute;
                }
                volMixPaint();
            }
        }

        // ── Hotkey capture ──
        function volMixStartBind(which) {
            if (volMixBinding) return;
            volMixBinding = which;
            volMixPaint();
            document.addEventListener('keydown', volMixCaptureKey, true);
        }

        async function volMixCaptureKey(e) {
            if (!volMixBinding) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const which = volMixBinding;
            // Esc clears the binding.
            if (e.key === 'Escape') {
                volMixFinishBind(which, '');
                return;
            }
            const acc = keyEventToAccelerator(e);
            if (!acc) return; // modifier-only, keep waiting
            volMixFinishBind(which, toElectronAccelerator(acc));
        }

        async function volMixFinishBind(which, accelerator) {
            document.removeEventListener('keydown', volMixCaptureKey, true);
            volMixBinding = null;
            if (window.electronAPI?.volumeMixerSetHotkey) {
                const res = await window.electronAPI.volumeMixerSetHotkey(which, accelerator);
                if (res && res.hotkeys) volMixHotkeys = res.hotkeys;
                if (res && res.ok === false && accelerator) {
                    showToast(res.error === 'conflict' ? 'That combo is already used' : 'That combo is unavailable', true);
                } else if (accelerator) {
                    showToast('Hotkey set');
                } else {
                    showToast('Hotkey cleared');
                }
            }
            volMixPaint();
        }
