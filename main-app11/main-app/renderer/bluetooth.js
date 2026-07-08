        // ── Bluetooth Manager mini widget ──
        // Lists paired devices with their live connection status and battery level,
        // connects / disconnects / removes them, and scans for + pairs nearby
        // devices. All the Win32 Bluetooth work happens in the main process
        // (main/bluetooth.js); this file is the management UI plus an auto-refresh
        // loop that keeps the list current while the panel is open.
        //
        // Bluetooth addresses are 12 hex digits (validated in the main process too),
        // so they're safe to embed directly in inline handlers.

        let bluetoothData = { devices: [] };   // last paired-device snapshot
        let bluetoothScanResults = [];          // unpaired devices from the last scan
        const bluetoothBusy = {};               // address -> true while an action runs
        let bluetoothScanning = false;
        let bluetoothRefreshTimer = null;

        const BLUETOOTH_REFRESH_MS = 8000;

        function isBluetoothEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.bluetooth;
        }

        function settingsOpen() {
            const modal = document.getElementById('settings-modal');
            return modal && !modal.classList.contains('hidden');
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
            if (!isBluetoothEnabled() || !settingsOpen() || bluetoothScanning) return;
            if (Object.keys(bluetoothBusy).length) return;
            if (!window.electronAPI?.bluetoothList) return;
            const res = await window.electronAPI.bluetoothList();
            if (res?.ok) { bluetoothData = res; bluetoothPaint(); }
        }

        // Full (re)load with a visible loading state — used on open / toggle / manual refresh.
        async function renderBluetoothPanel() {
            const panel = document.getElementById('bluetooth-panel');
            if (!panel) return;
            if (!isBluetoothEnabled()) { panel.innerHTML = ''; stopBluetoothAutoRefresh(); return; }
            if (!window.electronAPI?.bluetoothList) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Bluetooth control is unavailable.</p>`;
                return;
            }
            if (!bluetoothData.devices.length) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3"><i class="fas fa-circle-notch fa-spin mr-1.5"></i>Loading Bluetooth devices…</p>`;
            }
            const res = await window.electronAPI.bluetoothList();
            if (!isBluetoothEnabled()) { panel.innerHTML = ''; return; }
            if (res?.ok) bluetoothData = res;
            else if (!res) { panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Couldn't reach the Bluetooth radio. Is Bluetooth turned on?
                <button type="button" class="hotkey-bind no-drag ml-2" onclick="renderBluetoothPanel()">Retry</button></p>`; return; }
            bluetoothPaint();
        }

        function bluetoothDeviceIcon(name) {
            const n = (name || '').toLowerCase();
            if (/(airpod|buds|headphone|headset|wh-|wf-|beats|puro)/.test(n)) return 'fa-headphones';
            if (/(mouse)/.test(n)) return 'fa-computer-mouse';
            if (/(keyboard)/.test(n)) return 'fa-keyboard';
            if (/(speaker|sound|jbl|boom)/.test(n)) return 'fa-volume-high';
            if (/(tv|display)/.test(n)) return 'fa-tv';
            if (/(phone|pixel|galaxy|iphone)/.test(n)) return 'fa-mobile-screen';
            if (/(controller|gamepad|xbox|dualsense|dualshock)/.test(n)) return 'fa-gamepad';
            return 'fa-bluetooth-b';
        }

        function batteryBadge(level) {
            if (level === null || level === undefined) return '';
            let icon = 'fa-battery-full';
            if (level <= 15) icon = 'fa-battery-empty';
            else if (level <= 40) icon = 'fa-battery-quarter';
            else if (level <= 70) icon = 'fa-battery-half';
            else if (level <= 95) icon = 'fa-battery-three-quarters';
            const color = level <= 15 ? 'text-red-400' : 'text-neutral-400';
            return `<span class="text-[10px] ${color} font-mono ml-1"><i class="fas ${icon} mr-0.5"></i>${level}%</span>`;
        }

        function bluetoothPaint() {
            const panel = document.getElementById('bluetooth-panel');
            if (!panel) return;

            const devices = bluetoothData.devices || [];
            const paired = new Set(devices.map((d) => d.address));
            const scanNew = bluetoothScanResults.filter((d) => !paired.has(d.address) && !d.paired);

            const deviceRow = (d) => {
                const busy = !!bluetoothBusy[d.address];
                const iconClass = d.connected ? 'text-blue-400' : 'text-neutral-500';
                const statusEls = d.connected
                    ? `<span class="text-[10px] text-blue-400">Connected</span>${batteryBadge(d.battery)}`
                    : `<span class="text-[10px] text-neutral-600">Disconnected</span>`;
                const primaryBtn = d.connected
                    ? `<button type="button" onclick="bluetoothAction('disconnect','${d.address}')" ${busy ? 'disabled' : ''}
                         class="px-2.5 py-1 rounded-lg text-[11px] border bg-neutral-800/40 border-neutral-700/50 text-neutral-300 hover:text-white transition-colors no-drag">Disconnect</button>`
                    : `<button type="button" onclick="bluetoothAction('connect','${d.address}')" ${busy ? 'disabled' : ''}
                         class="px-2.5 py-1 rounded-lg text-[11px] border bg-blue-600/20 border-blue-600/40 text-blue-300 hover:bg-blue-600/30 transition-colors no-drag">Connect</button>`;
                return `<div class="flex items-center gap-2.5 border border-white/10 rounded-xl p-2.5">
                    <i class="fas ${bluetoothDeviceIcon(d.name)} ${iconClass} w-5 text-center"></i>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs text-neutral-200 truncate">${esc(d.name || 'Unknown device')}</p>
                        <div class="flex items-center gap-1">${statusEls}</div>
                    </div>
                    ${busy ? '<i class="fas fa-circle-notch fa-spin text-neutral-500 text-xs mr-1"></i>' : ''}
                    <div class="flex items-center gap-1 shrink-0">
                        ${primaryBtn}
                        <button type="button" title="Remove device" onclick="bluetoothRemove('${d.address}','${esc(d.name || '')}')" ${busy ? 'disabled' : ''}
                            class="w-7 h-7 flex items-center justify-center bg-neutral-800/30 hover:bg-red-800/50 border border-neutral-700/50 hover:border-red-700/50 text-neutral-400 hover:text-red-400 rounded-lg transition-colors no-drag"><i class="fas fa-trash text-[10px]"></i></button>
                    </div>
                </div>`;
            };

            let html = `<div class="flex items-center justify-between gap-3 mt-3 mb-2">
                <span class="text-[10px] uppercase tracking-widest text-neutral-600">${devices.length} paired</span>
                <div class="flex items-center gap-1.5">
                    <button type="button" class="hotkey-bind no-drag" onclick="renderBluetoothPanel()" title="Refresh"><i class="fas fa-rotate-right"></i></button>
                    <button type="button" class="hotkey-bind no-drag" onclick="bluetoothScan()" ${bluetoothScanning ? 'disabled' : ''}>
                        ${bluetoothScanning ? '<i class="fas fa-circle-notch fa-spin mr-1"></i>Scanning…' : '<i class="fas fa-magnifying-glass mr-1"></i>Scan'}</button>
                </div>
            </div>`;

            if (!devices.length) {
                html += `<p class="text-xs text-neutral-600 mb-2">No paired devices. Use Scan to find nearby ones.</p>`;
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
                        return `<div class="flex items-center gap-2.5 border border-white/10 rounded-xl p-2.5">
                            <i class="fas ${bluetoothDeviceIcon(d.name)} text-neutral-500 w-5 text-center"></i>
                            <div class="min-w-0 flex-1"><p class="text-xs text-neutral-200 truncate">${esc(d.name || 'Unknown device')}</p>
                                <span class="text-[10px] text-neutral-600">Not paired</span></div>
                            ${busy ? '<i class="fas fa-circle-notch fa-spin text-neutral-500 text-xs mr-1"></i>' : ''}
                            <button type="button" onclick="bluetoothPair('${d.address}','${esc(d.name || '')}')" ${busy ? 'disabled' : ''}
                                class="px-2.5 py-1 rounded-lg text-[11px] border bg-blue-600/20 border-blue-600/40 text-blue-300 hover:bg-blue-600/30 transition-colors no-drag shrink-0">Pair</button>
                        </div>`;
                    }).join('')}</div>`;
                }
            }

            panel.innerHTML = html;
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
                if (res?.ok) showToast('Device removed');
                else showToast('Could not remove device (may need admin rights)', true);
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
                const found = bluetoothScanResults.filter((d) => !d.paired).length;
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
