        // ── Bluetooth Manager mini widget ──
        // Lists paired devices with their live connection status, battery level,
        // device type and last-used time; connects / disconnects / removes them;
        // scans for + pairs nearby devices; toggles the Bluetooth radio itself on
        // and off; favourites devices (with optional auto-reconnect); and filters
        // the list by name. All the Win32 + WinRT work happens in the main process
        // (main/bluetooth.js); this file is the management UI plus an auto-refresh
        // loop that keeps the list current while the panel is open.
        //
        // Bluetooth addresses are 12 hex digits (validated in the main process too),
        // so they're safe to embed directly in inline handlers.

        let bluetoothData = { devices: [] };     // last paired-device snapshot
        let bluetoothRadio = null;               // { present, state, name } | null
        let bluetoothScanResults = [];           // unpaired devices from the last scan
        const bluetoothBusy = {};                // address -> true while an action runs
        let bluetoothScanning = false;
        let bluetoothRadioBusy = false;
        let bluetoothLoading = false;            // a full (re)load is in flight
        let bluetoothRefreshTimer = null;
        let bluetoothSearch = '';                // name filter text
        const bluetoothReconnectTried = {};      // address -> last auto-reconnect attempt ts

        const BLUETOOTH_REFRESH_MS = 8000;
        const BLUETOOTH_RECONNECT_THROTTLE_MS = 30000;

        function isBluetoothEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.bluetooth;
        }

        function settingsOpen() {
            const modal = document.getElementById('settings-modal');
            return modal && !modal.classList.contains('hidden');
        }

        // Favourites + auto-reconnect preferences (localStorage; keys kept stable).
        function bluetoothFavs() {
            return new Set(safeParseJSON(localStorage.getItem('bluetoothFavs'), []));
        }
        function isBluetoothFav(addr) {
            return bluetoothFavs().has(addr);
        }
        function bluetoothToggleFav(addr) {
            const favs = bluetoothFavs();
            if (favs.has(addr)) favs.delete(addr); else favs.add(addr);
            localStorage.setItem('bluetoothFavs', JSON.stringify([...favs]));
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            bluetoothPaint();
        }
        function isBluetoothAutoReconnect() {
            return localStorage.getItem('bluetoothAutoReconnect') === 'true';
        }
        function bluetoothToggleAutoReconnect() {
            const next = !isBluetoothAutoReconnect();
            localStorage.setItem('bluetoothAutoReconnect', String(next));
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            showToast(next ? 'Auto-reconnect favourites: on' : 'Auto-reconnect favourites: off');
            bluetoothPaint();
        }

        function applyBluetoothEnabled(enabled) {
            if (enabled) {
                renderBluetoothPanel();
                startBluetoothAutoRefresh();
            } else {
                stopBluetoothAutoRefresh();
            }
        }

        function startBluetoothAutoRefresh() {
            stopBluetoothAutoRefresh();
            bluetoothRefreshTimer = setInterval(bluetoothAutoRefresh, BLUETOOTH_REFRESH_MS);
        }

        function stopBluetoothAutoRefresh() {
            if (bluetoothRefreshTimer) {
                clearInterval(bluetoothRefreshTimer);
                bluetoothRefreshTimer = null;
            }
        }

        // Quiet periodic refresh — skips while the user is mid-action or scanning, or
        // when Settings is closed, so it never fights with what they're doing.
        async function bluetoothAutoRefresh() {
            if (!isBluetoothEnabled() || !settingsOpen() || bluetoothScanning || bluetoothRadioBusy) return;
            if (Object.keys(bluetoothBusy).length) return;
            if (!window.electronAPI?.bluetoothList) return;
            const res = await window.electronAPI.bluetoothList();
            if (res?.ok) { bluetoothData = res; bluetoothPaint(); maybeAutoReconnect(); }
        }

        // Auto-reconnect: while the panel is open, quietly try to reconnect any
        // favourited device that's disconnected — at most once every 30s each, and
        // never while the user is doing something. Opt-in via the header toggle.
        function maybeAutoReconnect() {
            if (!isBluetoothAutoReconnect() || bluetoothScanning || bluetoothRadioBusy) return;
            if (bluetoothRadio && bluetoothRadio.present && bluetoothRadio.state === 'off') return;
            if (Object.keys(bluetoothBusy).length) return;
            const favs = bluetoothFavs();
            const now = Date.now();
            const target = (bluetoothData.devices || []).find((d) =>
                favs.has(d.address) && !d.connected &&
                (now - (bluetoothReconnectTried[d.address] || 0)) > BLUETOOTH_RECONNECT_THROTTLE_MS
            );
            if (!target) return;
            bluetoothReconnectTried[target.address] = now;
            showToast(`Reconnecting ${target.name || 'favourite'}…`);
            bluetoothAction('connect', target.address);
        }

        // Full (re)load with a visible loading state — used on open / toggle / manual
        // refresh. Uses `status` so it also picks up the radio power state in one call.
        // The status call is PowerShell + WinRT backed and can take several seconds on
        // a cold start, so we must never leave the panel blank while it runs: if we
        // already have devices we keep showing them (with a subtle refreshing hint in
        // the toolbar); otherwise we show a loading placeholder. The panel div is
        // recreated empty every time the library detail reopens, which is exactly when
        // this used to flash blank.
        async function renderBluetoothPanel() {
            const panel = document.getElementById('bluetooth-panel');
            if (!panel) return;
            if (!isBluetoothEnabled()) { panel.innerHTML = ''; stopBluetoothAutoRefresh(); return; }
            if (!window.electronAPI?.bluetoothStatus && !window.electronAPI?.bluetoothList) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Bluetooth control is unavailable.</p>`;
                return;
            }
            bluetoothLoading = true;
            if (bluetoothData.devices.length) {
                bluetoothPaint();                       // keep known devices visible, mark as refreshing
            } else {
                panel.innerHTML = bluetoothLoadingSkeleton();
            }
            let res;
            try {
                res = window.electronAPI.bluetoothStatus
                    ? await window.electronAPI.bluetoothStatus()
                    : await window.electronAPI.bluetoothList();
            } finally {
                bluetoothLoading = false;
            }
            if (!isBluetoothEnabled()) { panel.innerHTML = ''; return; }
            // macOS: the blueutil CLI isn't installed yet → offer a 1-click install.
            if (res && res.needsTool && !bluetoothData.devices.length) {
                stopBluetoothAutoRefresh();
                panel.innerHTML = macToolMissingMarkup(res.needsTool, res.toolLabel, 'renderBluetoothPanel');
                return;
            }
            if (res?.ok) {
                bluetoothData = { devices: res.devices || [] };
                if ('radio' in res) bluetoothRadio = res.radio || null;
            } else if (!res && !bluetoothData.devices.length) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Couldn't reach the Bluetooth radio. Is Bluetooth turned on?
                    <button type="button" class="hotkey-bind no-drag ml-2" onclick="renderBluetoothPanel()">Retry</button></p>`;
                return;
            }
            bluetoothPaint();
        }

        // Loading placeholder shown on a cold open (no cached devices yet). A spinner
        // line plus a few shimmering rows so a slow status call reads as "loading",
        // not "broken" or "empty".
        function bluetoothLoadingSkeleton() {
            const row = `<div class="bt-device bt-skeleton flex items-center gap-2.5 border border-white/10 rounded-xl p-2.5">
                <span class="bt-icon"><span class="bt-skel bt-skel-dot"></span></span>
                <div class="min-w-0 flex-1 space-y-1.5">
                    <span class="bt-skel bt-skel-bar" style="width:55%"></span>
                    <span class="bt-skel bt-skel-bar" style="width:32%"></span>
                </div>
            </div>`;
            return `<div class="flex items-center gap-2 text-xs text-neutral-400 mt-3 mb-2">
                    <i class="fas fa-circle-notch fa-spin"></i><span>Loading Bluetooth devices…</span>
                </div>
                <div class="space-y-2">${row}${row}${row}</div>`;
        }

        // Type → friendly label + Font Awesome icon. The name-based guess wins when
        // it matches (more specific), otherwise we fall back to the device's
        // class-of-device `type` reported by the backend.
        const BLUETOOTH_TYPE_META = {
            headphones: { label: 'Headphones', icon: 'fa-headphones' },
            headset: { label: 'Headset', icon: 'fa-headset' },
            speaker: { label: 'Speaker', icon: 'fa-volume-high' },
            microphone: { label: 'Microphone', icon: 'fa-microphone' },
            audio: { label: 'Audio', icon: 'fa-music' },
            mouse: { label: 'Mouse', icon: 'fa-computer-mouse' },
            keyboard: { label: 'Keyboard', icon: 'fa-keyboard' },
            gamepad: { label: 'Controller', icon: 'fa-gamepad' },
            peripheral: { label: 'Input device', icon: 'fa-keyboard' },
            phone: { label: 'Phone', icon: 'fa-mobile-screen' },
            computer: { label: 'Computer', icon: 'fa-laptop' },
            wearable: { label: 'Wearable', icon: 'fa-clock' },
            imaging: { label: 'Imaging', icon: 'fa-print' },
            network: { label: 'Network', icon: 'fa-network-wired' },
            health: { label: 'Health', icon: 'fa-heart-pulse' },
            toy: { label: 'Toy', icon: 'fa-robot' },
            unknown: { label: 'Device', icon: 'fa-bluetooth-b' }
        };

        function bluetoothNameIcon(name) {
            const n = (name || '').toLowerCase();
            if (/(airpod|buds|headphone|wh-|wf-|beats|puro)/.test(n)) return 'fa-headphones';
            if (/(headset|handsfree)/.test(n)) return 'fa-headset';
            if (/(mouse|mx master|g pro)/.test(n)) return 'fa-computer-mouse';
            if (/(keyboard|keychron|keeb)/.test(n)) return 'fa-keyboard';
            if (/(speaker|sound|jbl|boom|flip|charge)/.test(n)) return 'fa-volume-high';
            if (/(tv|display)/.test(n)) return 'fa-tv';
            if (/(phone|pixel|galaxy|iphone|oneplus)/.test(n)) return 'fa-mobile-screen';
            if (/(controller|gamepad|xbox|dualsense|dualshock|8bitdo)/.test(n)) return 'fa-gamepad';
            if (/(watch|band|fit)/.test(n)) return 'fa-clock';
            return null;
        }

        function bluetoothDeviceIcon(d) {
            return bluetoothNameIcon(d.name) || (BLUETOOTH_TYPE_META[d.type] || BLUETOOTH_TYPE_META.unknown).icon;
        }
        function bluetoothTypeLabel(d) {
            return (BLUETOOTH_TYPE_META[d.type] || BLUETOOTH_TYPE_META.unknown).label;
        }

        function bluetoothRelTime(iso) {
            if (!iso) return '';
            const then = new Date(iso.replace(' ', 'T')).getTime();
            if (!then || isNaN(then)) return '';
            const diff = Date.now() - then;
            if (diff < 0) return '';
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins}m ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return `${hrs}h ago`;
            const days = Math.floor(hrs / 24);
            if (days < 30) return `${days}d ago`;
            const months = Math.floor(days / 30);
            if (months < 12) return `${months}mo ago`;
            return `${Math.floor(months / 12)}y ago`;
        }

        function batteryBadge(level) {
            if (level === null || level === undefined) return '';
            let icon = 'fa-battery-full';
            if (level <= 15) icon = 'fa-battery-empty';
            else if (level <= 40) icon = 'fa-battery-quarter';
            else if (level <= 70) icon = 'fa-battery-half';
            else if (level <= 95) icon = 'fa-battery-three-quarters';
            const color = level <= 15 ? 'text-red-400' : (level <= 40 ? 'text-amber-400' : 'text-emerald-400');
            return `<span class="text-[10px] ${color} font-mono ml-1" title="Battery ${level}%"><i class="fas ${icon} mr-0.5"></i>${level}%</span>`;
        }

        // Connected first, then favourites, then alphabetical — a stable, predictable
        // order that keeps what you use at the top.
        function bluetoothSortDevices(devices) {
            const favs = bluetoothFavs();
            return [...devices].sort((a, b) => {
                if (!!a.connected !== !!b.connected) return a.connected ? -1 : 1;
                const fa = favs.has(a.address), fb = favs.has(b.address);
                if (fa !== fb) return fa ? -1 : 1;
                return (a.name || '').localeCompare(b.name || '');
            });
        }

        function bluetoothSetSearch(value) {
            bluetoothSearch = value || '';
            bluetoothPaint(true);
        }

        // keepFocus: preserve the search input's focus/caret across the repaint that
        // typing into it triggers.
        function bluetoothPaint(keepFocus = false) {
            const panel = document.getElementById('bluetooth-panel');
            if (!panel) return;

            const allDevices = bluetoothData.devices || [];
            const paired = new Set(allDevices.map((d) => d.address));
            const q = bluetoothSearch.trim().toLowerCase();
            const filtered = q
                ? allDevices.filter((d) => (d.name || '').toLowerCase().includes(q) || d.address.toLowerCase().includes(q))
                : allDevices;
            const devices = bluetoothSortDevices(filtered);
            const connectedCount = allDevices.filter((d) => d.connected).length;
            const scanNew = bluetoothScanResults.filter((d) => !paired.has(d.address) && !d.paired);

            const favs = bluetoothFavs();
            const deviceRow = (d) => {
                const busy = !!bluetoothBusy[d.address];
                const fav = favs.has(d.address);
                const iconClass = d.connected ? 'text-blue-400' : 'text-neutral-500';
                const lastUsed = !d.connected ? bluetoothRelTime(d.lastUsed) : '';
                const meta = [`<span class="text-[10px] text-neutral-500">${esc(bluetoothTypeLabel(d))}</span>`];
                if (d.connected) {
                    meta.push(`<span class="bt-dot bt-dot-on"></span><span class="text-[10px] text-blue-400">Connected</span>${batteryBadge(d.battery)}`);
                } else {
                    meta.push(`<span class="bt-dot"></span><span class="text-[10px] text-neutral-600">Disconnected${lastUsed ? ' · ' + esc(lastUsed) : ''}</span>`);
                }
                const primaryBtn = d.connected
                    ? `<button type="button" onclick="bluetoothAction('disconnect',${jsAttr(d.address)})" ${busy ? 'disabled' : ''}
                         class="px-2.5 py-1 rounded-lg text-[11px] border bg-neutral-800/40 border-neutral-700/50 text-neutral-300 hover:text-white transition-colors no-drag">Disconnect</button>`
                    : `<button type="button" onclick="bluetoothAction('connect',${jsAttr(d.address)})" ${busy ? 'disabled' : ''}
                         class="px-2.5 py-1 rounded-lg text-[11px] border bg-blue-600/20 border-blue-600/40 text-blue-300 hover:bg-blue-600/30 transition-colors no-drag">Connect</button>`;
                return `<div class="bt-device flex items-center gap-2.5 border border-white/10 rounded-xl p-2.5${d.connected ? ' bt-device-on' : ''}">
                    <span class="bt-icon"><i class="fas ${bluetoothDeviceIcon(d)} ${iconClass}"></i></span>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs text-neutral-200 truncate">${esc(d.name || 'Unknown device')}</p>
                        <div class="flex items-center gap-1.5 flex-wrap">${meta.join('')}</div>
                    </div>
                    ${busy ? '<i class="fas fa-circle-notch fa-spin text-neutral-500 text-xs mr-1"></i>' : ''}
                    <div class="flex items-center gap-1 shrink-0">
                        <button type="button" title="${fav ? 'Unfavourite' : 'Favourite'}" onclick="bluetoothToggleFav(${jsAttr(d.address)})"
                            class="bt-iconbtn ${fav ? 'bt-fav-on' : ''} no-drag"><i class="${fav ? 'fas' : 'far'} fa-star text-[10px]"></i></button>
                        ${primaryBtn}
                        <button type="button" title="Remove device" onclick="bluetoothRemove(${jsAttr(d.address)},${jsAttr(d.name || '')})" ${busy ? 'disabled' : ''}
                            class="bt-iconbtn bt-iconbtn-danger no-drag"><i class="fas fa-trash text-[10px]"></i></button>
                    </div>
                </div>`;
            };

            let html = '';

            // ── Radio power header ──
            html += bluetoothRadioHeader();

            // Toolbar: count summary + search + refresh + scan.
            html += `<div class="flex items-center justify-between gap-3 mt-3 mb-2">
                <span class="text-[10px] uppercase tracking-widest text-neutral-600">${allDevices.length} paired${connectedCount ? ` · ${connectedCount} on` : ''}</span>
                <div class="flex items-center gap-1.5">
                    <button type="button" class="hotkey-bind no-drag ${isBluetoothAutoReconnect() ? 'bt-toggle-on' : ''}" onclick="bluetoothToggleAutoReconnect()"
                        title="Auto-reconnect favourite devices when they drop"><i class="fas fa-arrows-rotate mr-1"></i>Auto</button>
                    <button type="button" class="hotkey-bind no-drag" onclick="renderBluetoothPanel()" ${bluetoothLoading ? 'disabled' : ''} title="${bluetoothLoading ? 'Refreshing…' : 'Refresh'}"><i class="fas ${bluetoothLoading ? 'fa-circle-notch fa-spin' : 'fa-rotate-right'}"></i></button>
                    <button type="button" class="hotkey-bind no-drag" onclick="bluetoothScan()" ${bluetoothScanning ? 'disabled' : ''}>
                        ${bluetoothScanning ? '<i class="fas fa-circle-notch fa-spin mr-1"></i>Scanning…' : '<i class="fas fa-magnifying-glass mr-1"></i>Scan'}</button>
                </div>
            </div>`;

            if (allDevices.length > 4 || q) {
                html += `<div class="bt-search mb-2"><i class="fas fa-magnifying-glass"></i>
                    <input type="text" id="bluetooth-search-input" class="no-drag" placeholder="Filter devices…" value="${esc(bluetoothSearch)}"
                        oninput="bluetoothSetSearch(this.value)" spellcheck="false" autocomplete="off">
                    ${q ? `<button type="button" class="bt-search-clear no-drag" onclick="bluetoothSetSearch('')" title="Clear"><i class="fas fa-xmark"></i></button>` : ''}
                </div>`;
            }

            if (!allDevices.length) {
                html += `<p class="text-xs text-neutral-600 mb-2">No paired devices. Use Scan to find nearby ones.</p>`;
            } else if (!devices.length) {
                html += `<p class="text-xs text-neutral-600 mb-2">No devices match "${esc(bluetoothSearch)}".</p>`;
            } else {
                html += `<div class="space-y-2">${devices.map(deviceRow).join('')}</div>`;
            }

            // Newly discovered (unpaired) devices from a scan.
            if (bluetoothScanning || scanNew.length) {
                html += `<p class="text-[10px] uppercase tracking-widest text-neutral-600 mt-4 mb-2">Nearby</p>`;
                if (bluetoothScanning && !scanNew.length) {
                    html += `<p class="text-xs text-neutral-600">Searching for nearby devices…</p>`;
                } else {
                    html += `<div class="space-y-2">${scanNew.map((d) => {
                        const busy = !!bluetoothBusy[d.address];
                        return `<div class="bt-device flex items-center gap-2.5 border border-white/10 rounded-xl p-2.5">
                            <span class="bt-icon"><i class="fas ${bluetoothDeviceIcon(d)} text-neutral-500"></i></span>
                            <div class="min-w-0 flex-1"><p class="text-xs text-neutral-200 truncate">${esc(d.name || 'Unknown device')}</p>
                                <span class="text-[10px] text-neutral-600">${esc(bluetoothTypeLabel(d))} · Not paired</span></div>
                            ${busy ? '<i class="fas fa-circle-notch fa-spin text-neutral-500 text-xs mr-1"></i>' : ''}
                            <button type="button" onclick="bluetoothPair(${jsAttr(d.address)},${jsAttr(d.name || '')})" ${busy ? 'disabled' : ''}
                                class="px-2.5 py-1 rounded-lg text-[11px] border bg-blue-600/20 border-blue-600/40 text-blue-300 hover:bg-blue-600/30 transition-colors no-drag shrink-0">Pair</button>
                        </div>`;
                    }).join('')}</div>`;
                }
            }

            panel.innerHTML = html;

            // Restore focus/caret to the search box after the repaint from typing.
            if (keepFocus) {
                const input = document.getElementById('bluetooth-search-input');
                if (input) { input.focus(); const v = input.value; input.value = ''; input.value = v; }
            }
        }

        // The radio power card at the top of the panel. Hidden gracefully when the
        // WinRT radio API isn't available (older Windows) — the rest of the manager
        // still works via the Win32 device APIs.
        function bluetoothRadioHeader() {
            if (!bluetoothRadio || !bluetoothRadio.present) return '';
            const on = bluetoothRadio.state === 'on';
            const name = bluetoothRadio.name || 'Bluetooth';
            return `<div class="bt-radio ${on ? 'bt-radio-on' : 'bt-radio-off'} mt-3">
                <span class="bt-radio-glyph"><i class="fab fa-bluetooth-b"></i></span>
                <div class="min-w-0 flex-1">
                    <p class="text-xs text-neutral-100 truncate">${esc(name)}</p>
                    <p class="text-[10px] ${on ? 'text-blue-300' : 'text-neutral-500'}">${on ? 'Bluetooth is on' : 'Bluetooth is off'}</p>
                </div>
                ${bluetoothRadioBusy
                    ? '<i class="fas fa-circle-notch fa-spin text-neutral-400 text-sm mr-1"></i>'
                    : `<button type="button" role="switch" aria-checked="${on}" onclick="bluetoothRadioToggle()"
                         class="bt-switch ${on ? 'bt-switch-on' : ''} no-drag" title="${on ? 'Turn Bluetooth off' : 'Turn Bluetooth on'}"><span class="bt-switch-knob"></span></button>`}
            </div>`;
        }

        async function bluetoothRadioToggle() {
            if (bluetoothRadioBusy || !window.electronAPI?.bluetoothRadioSet) return;
            const turningOn = !(bluetoothRadio && bluetoothRadio.state === 'on');
            bluetoothRadioBusy = true;
            bluetoothPaint();
            showToast(turningOn ? 'Turning Bluetooth on…' : 'Turning Bluetooth off…');
            try {
                const res = await window.electronAPI.bluetoothRadioSet('toggle');
                if (res?.radio) bluetoothRadio = res.radio;
                if (res?.ok) showToast(res.radio?.state === 'on' ? 'Bluetooth on' : 'Bluetooth off');
                else showToast('Could not change the Bluetooth radio (may need permission)', true);
            } catch (e) {
                showToast('Bluetooth radio toggle failed', true);
            } finally {
                bluetoothRadioBusy = false;
            }
            // Re-read the full state (radio + devices) after the radio settles.
            setTimeout(() => renderBluetoothPanel(), 800);
        }

        async function bluetoothAction(kind, address) {
            if (bluetoothBusy[address] || !window.electronAPI?.[kind === 'connect' ? 'bluetoothConnect' : 'bluetoothDisconnect']) return;
            bluetoothBusy[address] = true;
            bluetoothPaint();
            showToast(kind === 'connect' ? 'Connecting…' : 'Disconnecting…');
            try {
                const res = kind === 'connect'
                    ? await window.electronAPI.bluetoothConnect(address)
                    : await window.electronAPI.bluetoothDisconnect(address);
                if (res?.ok) showToast(kind === 'connect' ? 'Connected' : 'Disconnected');
                else showToast(`Could not ${kind} — the device may be out of range`, true);
            } catch (e) {
                showToast(`Bluetooth ${kind} failed`, true);
            } finally {
                delete bluetoothBusy[address];
            }
            // Give the radio a moment to settle, then refresh true status.
            setTimeout(() => renderBluetoothPanel(), 1200);
        }

        async function bluetoothRemove(address, name) {
            if (bluetoothBusy[address] || !window.electronAPI?.bluetoothRemove) return;
            if (!confirm(`Remove ${name || 'this device'}? You'll need to pair it again to use it.`)) return;
            bluetoothBusy[address] = true;
            bluetoothPaint();
            showToast('Removing device…');
            try {
                const res = await window.electronAPI.bluetoothRemove(address);
                if (res?.ok) {
                    showToast('Device removed');
                    // Drop it from favourites too so it doesn't linger as a ghost.
                    const favs = bluetoothFavs();
                    if (favs.has(address)) { favs.delete(address); localStorage.setItem('bluetoothFavs', JSON.stringify([...favs])); }
                } else {
                    showToast('Could not remove device (may need admin rights)', true);
                }
            } catch (e) {
                showToast('Remove failed', true);
            } finally {
                delete bluetoothBusy[address];
            }
            renderBluetoothPanel();
        }

        async function bluetoothScan() {
            if (bluetoothScanning || !window.electronAPI?.bluetoothScan) return;
            bluetoothScanning = true;
            bluetoothPaint();
            showToast('Scanning for nearby devices…');
            try {
                const res = await window.electronAPI.bluetoothScan();
                bluetoothScanResults = res?.ok ? (res.devices || []) : [];
                const paired = new Set((bluetoothData.devices || []).map((d) => d.address));
                const found = bluetoothScanResults.filter((d) => !d.paired && !paired.has(d.address)).length;
                showToast(found ? `Found ${found} nearby device${found === 1 ? '' : 's'}` : 'No new devices found');
            } catch (e) {
                showToast('Scan failed', true);
            } finally {
                bluetoothScanning = false;
            }
            bluetoothPaint();
        }

        async function bluetoothPair(address, name) {
            if (bluetoothBusy[address] || !window.electronAPI?.bluetoothPair) return;
            bluetoothBusy[address] = true;
            bluetoothPaint();
            showToast(`Pairing with ${name || 'device'}…`);
            try {
                const res = await window.electronAPI.bluetoothPair(address);
                if (res?.ok) {
                    showToast('Paired');
                    // Drop it from the scan list; it'll show up in the paired list.
                    bluetoothScanResults = bluetoothScanResults.filter((d) => d.address !== address);
                } else {
                    showToast('Pairing failed — the device may need a PIN or a confirmation', true);
                }
            } catch (e) {
                showToast('Pairing failed', true);
            } finally {
                delete bluetoothBusy[address];
            }
            renderBluetoothPanel();
        }
