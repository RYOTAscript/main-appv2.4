        // ── Screen Resolution Manager mini widget ──
        // Detects every attached monitor and its supported modes (via the main
        // process / Win32 GDI), lets you switch resolution + refresh rate instantly,
        // favourite the modes you use most, and auto-reverts an unsupported switch
        // after 15 seconds — the same safety net Windows' own display settings use.
        //
        // Handlers are keyed by the monitor's INDEX in the cached list rather than
        // its device name, because device names look like "\\.\DISPLAY1" and would
        // be mangled by JS string-escaping if embedded in inline onclick attributes.

        let screenResData = null;              // { ok, monitors:[...] } from last fetch
        let screenResSelections = {};          // index -> { width, height, refresh }
        const screenResReverts = {};           // index -> { timer, interval, deadline, previous }

        function isScreenResEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.screenResolution;
        }

        function screenResFavourites() {
            return safeParseJSON(localStorage.getItem('screenResFavourites'), {});
        }

        function screenResSaveFavourites(favs) {
            localStorage.setItem('screenResFavourites', JSON.stringify(favs));
        }

        function modeKey(w, h, r) { return `${w}x${h}x${r}`; }
        function modeLabel(w, h, r) { return `${w} × ${h} @ ${r}Hz`; }

        // Fetches fresh display data from the main process and repaints. Called when
        // Settings opens, when the widget is toggled on, and on manual refresh.
        async function renderScreenResolutionPanel() {
            const panel = document.getElementById('screen-resolution-panel');
            if (!panel) return;
            if (!isScreenResEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.screenResolutionList) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Display control is unavailable.</p>`;
                return;
            }
            panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3"><i class="fas fa-circle-notch fa-spin mr-1.5"></i>Detecting displays…</p>`;
            const res = await window.electronAPI.screenResolutionList();
            if (!isScreenResEnabled()) { panel.innerHTML = ''; return; }
            screenResData = res;
            if (!res.ok || !res.monitors.length) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Couldn't detect any displays.
                    <button type="button" class="hotkey-bind no-drag ml-2" onclick="renderScreenResolutionPanel()">Retry</button></p>`;
                return;
            }
            // Seed each monitor's selection from its current mode (unless the user
            // already has an active selection we should preserve across a refresh).
            res.monitors.forEach((mon, idx) => {
                if (!screenResSelections[idx] && mon.current) {
                    screenResSelections[idx] = { ...mon.current };
                }
            });
            screenResPaint();
        }

        // Repaints from cached data only (no fetch) — used for selection changes.
        function screenResPaint() {
            const panel = document.getElementById('screen-resolution-panel');
            if (!panel || !screenResData?.monitors) return;
            const favs = screenResFavourites();

            const cards = screenResData.monitors.map((mon, idx) => {
                const sel = screenResSelections[idx] || mon.current || {};
                const monFavs = favs[mon.id] || [];

                // Unique resolutions (WxH), preserving the big→small order from main.
                const resList = [];
                const seenRes = new Set();
                for (const m of mon.modes) {
                    const rk = `${m.width}x${m.height}`;
                    if (!seenRes.has(rk)) { seenRes.add(rk); resList.push({ width: m.width, height: m.height }); }
                }
                // Refresh rates available for the currently selected resolution.
                const refreshList = mon.modes
                    .filter((m) => m.width === sel.width && m.height === sel.height)
                    .map((m) => m.refresh)
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .sort((a, b) => b - a);

                const resOptions = resList.map((r) =>
                    `<option value="${r.width}x${r.height}" ${r.width === sel.width && r.height === sel.height ? 'selected' : ''}>${r.width} × ${r.height}</option>`
                ).join('');
                const refreshOptions = refreshList.map((r) =>
                    `<option value="${r}" ${r === sel.refresh ? 'selected' : ''}>${r} Hz</option>`
                ).join('');

                const isCurrent = mon.current && sel.width === mon.current.width && sel.height === mon.current.height && sel.refresh === mon.current.refresh;
                const isFav = monFavs.includes(modeKey(sel.width, sel.height, sel.refresh));

                const favChips = monFavs.length ? `<div class="flex flex-wrap gap-1.5 mt-2">${monFavs.map((k) => {
                    const [w, h, r] = k.split('x').map(Number);
                    const active = mon.current && w === mon.current.width && h === mon.current.height && r === mon.current.refresh;
                    return `<button type="button" onclick="screenResApplyFav(${idx}, ${w}, ${h}, ${r})"
                        class="px-2 py-1 rounded-lg text-[10px] border transition-colors no-drag ${active ? 'bg-white/15 border-white/25 text-white' : 'bg-neutral-800/40 border-neutral-700/50 text-neutral-300 hover:text-white'}"
                        title="Apply favourite"><i class="fas fa-star text-amber-400 mr-1"></i>${modeLabel(w, h, r)}</button>`;
                }).join('')}</div>` : '';

                const revert = screenResReverts[idx];
                const revertBar = revert ? `<div class="flex items-center justify-between gap-3 border border-amber-600/40 bg-amber-600/10 rounded-xl p-3 mt-3">
                    <span class="text-[11px] text-amber-300">Keep this display mode? Reverting in <span id="screen-res-countdown-${idx}" class="font-mono">15</span>s…</span>
                    <button type="button" class="hotkey-bind no-drag shrink-0" onclick="screenResKeep(${idx})">Keep</button>
                </div>` : '';

                return `<div class="border border-white/10 rounded-xl p-3 mt-3">
                    <div class="flex items-center justify-between gap-2 mb-2">
                        <div class="min-w-0">
                            <p class="text-xs text-neutral-200 truncate">${esc(mon.name)}${mon.primary ? ' <span class="text-[9px] text-neutral-500">• Primary</span>' : ''}</p>
                            <p class="text-[10px] text-neutral-500">Current: ${mon.current ? modeLabel(mon.current.width, mon.current.height, mon.current.refresh) : '—'}</p>
                        </div>
                        <button type="button" onclick="screenResToggleFav(${idx})" title="${isFav ? 'Unfavourite this mode' : 'Favourite this mode'}"
                            class="w-7 h-7 flex items-center justify-center rounded-lg border border-neutral-700/50 ${isFav ? 'text-amber-400' : 'text-neutral-500'} hover:text-amber-300 transition-colors no-drag shrink-0"><i class="${isFav ? 'fas' : 'far'} fa-star text-xs"></i></button>
                    </div>
                    <div class="flex items-center gap-2">
                        <select onchange="screenResOnResChange(${idx}, this.value)"
                            class="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">${resOptions}</select>
                        <select onchange="screenResOnRefreshChange(${idx}, this.value)"
                            class="w-24 bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">${refreshOptions}</select>
                        <button type="button" onclick="screenResApply(${idx})" ${isCurrent ? 'disabled' : ''}
                            class="px-3 py-1.5 rounded-lg text-xs border transition-colors no-drag ${isCurrent ? 'bg-neutral-800/30 border-neutral-800 text-neutral-600 cursor-default' : 'bg-white/10 border-white/20 text-white hover:bg-white/20'}">${isCurrent ? 'Active' : 'Apply'}</button>
                    </div>
                    ${favChips}
                    ${revertBar}
                </div>`;
            }).join('');

            panel.innerHTML = `<div class="flex items-center justify-between gap-3 mt-3 mb-1">
                    <span class="text-[10px] uppercase tracking-widest text-neutral-600">${screenResData.monitors.length} display${screenResData.monitors.length === 1 ? '' : 's'}</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="renderScreenResolutionPanel()"><i class="fas fa-rotate-right mr-1"></i>Refresh</button>
                </div>${cards}`;

            // Re-attach any live countdown displays after the repaint.
            for (const idx of Object.keys(screenResReverts)) {
                const rv = screenResReverts[idx];
                const el = document.getElementById(`screen-res-countdown-${idx}`);
                if (el && rv) el.textContent = String(Math.max(0, Math.ceil((rv.deadline - Date.now()) / 1000)));
            }
        }

        function screenResOnResChange(idx, value) {
            const [width, height] = value.split('x').map(Number);
            const mon = screenResData?.monitors[idx];
            if (!mon) return;
            // Pick the highest refresh available for the new resolution (or keep the
            // current one if it's still valid).
            const refreshes = mon.modes.filter((m) => m.width === width && m.height === height).map((m) => m.refresh);
            const prev = screenResSelections[idx]?.refresh;
            const refresh = refreshes.includes(prev) ? prev : Math.max(...refreshes);
            screenResSelections[idx] = { width, height, refresh };
            screenResPaint();
        }

        function screenResOnRefreshChange(idx, value) {
            if (!screenResSelections[idx]) return;
            screenResSelections[idx].refresh = Number(value);
            screenResPaint();
        }

        function screenResToggleFav(idx) {
            const mon = screenResData?.monitors[idx];
            const sel = screenResSelections[idx];
            if (!mon || !sel) return;
            const favs = screenResFavourites();
            const list = favs[mon.id] || [];
            const key = modeKey(sel.width, sel.height, sel.refresh);
            const pos = list.indexOf(key);
            if (pos >= 0) { list.splice(pos, 1); showToast('Removed favourite'); }
            else { list.push(key); showToast('Favourited mode'); }
            favs[mon.id] = list;
            screenResSaveFavourites(favs);
            screenResPaint();
        }

        async function screenResApplyFav(idx, w, h, r) {
            screenResSelections[idx] = { width: w, height: h, refresh: r };
            await screenResApply(idx);
        }

        async function screenResApply(idx) {
            const mon = screenResData?.monitors[idx];
            const sel = screenResSelections[idx];
            if (!mon || !sel || !window.electronAPI?.screenResolutionSet) return;
            const previous = mon.current ? { ...mon.current } : null;
            showToast('Applying display mode…');
            const res = await window.electronAPI.screenResolutionSet(mon.id, sel.width, sel.height, sel.refresh);
            if (!res?.ok) {
                showToast('This display mode was rejected', true);
                return;
            }
            // Reflect the applied mode as current and start the 15s keep/revert timer.
            mon.current = { ...sel };
            if (previous && (previous.width !== sel.width || previous.height !== sel.height || previous.refresh !== sel.refresh)) {
                startScreenResRevert(idx, previous);
            } else {
                showToast('Display mode applied');
            }
            screenResPaint();
        }

        // Starts the "keep or auto-revert" safety countdown for a monitor. If the user
        // doesn't confirm within 15s (e.g. the new mode is a black screen and they
        // can't see the Keep button), the previous mode is restored automatically.
        function startScreenResRevert(idx, previous) {
            clearScreenResRevert(idx);
            const deadline = Date.now() + 15000;
            const interval = setInterval(() => {
                const el = document.getElementById(`screen-res-countdown-${idx}`);
                if (el) el.textContent = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
            }, 250);
            const timer = setTimeout(() => doScreenResRevert(idx), 15000);
            screenResReverts[idx] = { timer, interval, deadline, previous };
        }

        function clearScreenResRevert(idx) {
            const rv = screenResReverts[idx];
            if (!rv) return;
            clearTimeout(rv.timer);
            clearInterval(rv.interval);
            delete screenResReverts[idx];
        }

        function screenResKeep(idx) {
            clearScreenResRevert(idx);
            showToast('Display mode kept');
            screenResPaint();
        }

        async function doScreenResRevert(idx) {
            const rv = screenResReverts[idx];
            const mon = screenResData?.monitors[idx];
            clearScreenResRevert(idx);
            if (!rv || !mon || !rv.previous || !window.electronAPI?.screenResolutionSet) return;
            const p = rv.previous;
            await window.electronAPI.screenResolutionSet(mon.id, p.width, p.height, p.refresh);
            mon.current = { ...p };
            screenResSelections[idx] = { ...p };
            showToast('Reverted — mode not confirmed', true);
            screenResPaint();
        }
