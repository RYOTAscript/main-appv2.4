        // ── Discord Rich Presence mini widget (renderer) ──
        // Config form + a live Discord-style preview card. Everything the user
        // types is sanitized and pushed to the main process (main/discordRpc.js),
        // which owns the actual IPC pipe to the Discord desktop client. The panel
        // div only exists while the widget's detail view is open, so every render
        // no-ops when it's absent.

        let discordRpcState = null;       // last full state from main
        let discordRpcSaveTimer = null;   // debounce for text-field edits
        let discordRpcStatusHooked = false;
        let discordRpcPreviewClock = null; // interval that ticks the elapsed time

        function isDiscordRpcEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.discordRpc;
        }

        async function applyDiscordRpcEnabled(enabled) {
            if (window.electronAPI?.discordRpcSetEnabled) {
                await window.electronAPI.discordRpcSetEnabled(!!enabled);
            }
            if (typeof renderDiscordRpcPanel === 'function') renderDiscordRpcPanel();
        }

        function hookDiscordRpcStatus() {
            if (discordRpcStatusHooked || !window.electronAPI?.onDiscordRpcStatus) return;
            discordRpcStatusHooked = true;
            window.electronAPI.onDiscordRpcStatus((data) => {
                if (!data) return;
                if (discordRpcState) {
                    discordRpcState.connected = data.connected;
                    discordRpcState.enabled = data.enabled;
                    discordRpcState.hasClientId = data.hasClientId;
                    discordRpcState.error = data.error;
                    if (data.appName !== undefined) discordRpcState.appName = data.appName;
                }
                discordRpcRenderStatusBadge();
                // A newly-fetched app name changes the preview's bold top line.
                const prev = document.getElementById('discord-rpc-preview');
                if (prev) prev.innerHTML = discordRpcPreviewHtml();
            });
        }

        async function renderDiscordRpcPanel() {
            const panel = document.getElementById('discord-rpc-panel');
            if (!panel) return;
            hookDiscordRpcStatus();
            if (!isDiscordRpcEnabled()) { panel.innerHTML = ''; stopDiscordRpcPreviewClock(); return; }
            if (!window.electronAPI?.discordRpcGet) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Discord Rich Presence is unavailable.</p>`;
                return;
            }
            const state = await window.electronAPI.discordRpcGet();
            if (!isDiscordRpcEnabled()) { panel.innerHTML = ''; return; }
            discordRpcState = state;
            discordRpcPaint();
        }

        function discordRpcCfg() {
            return (discordRpcState && discordRpcState.config) || {
                clientId: '', details: '', state: '', largeImageKey: '', largeImageText: '',
                smallImageKey: '', smallImageText: '', showTimestamp: true, buttons: []
            };
        }

        function discordRpcPaint() {
            const panel = document.getElementById('discord-rpc-panel');
            if (!panel) return;
            const c = discordRpcCfg();
            const b0 = c.buttons[0] || { label: '', url: '' };
            const b1 = c.buttons[1] || { label: '', url: '' };

            panel.innerHTML = `
                <div class="mt-3 space-y-4">
                    <div id="discord-rpc-status-badge">${discordRpcStatusBadgeHtml()}</div>

                    <div>
                        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Discord Application ID</label>
                        <input type="text" id="drpc-clientId" value="${esc(c.clientId)}" inputmode="numeric" placeholder="e.g. 1234567890123456789"
                            oninput="discordRpcOnEdit()" spellcheck="false"
                            class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        <p class="text-[10px] text-neutral-600 mt-1">Create an app at
                            <button type="button" class="underline hover:text-neutral-400" onclick="discordRpcOpenPortal()">discord.com/developers</button>,
                            then paste its Application ID here. Image keys below refer to Rich Presence "Art Assets" you upload there.</p>
                    </div>

                    <div class="grid grid-cols-1 gap-3">
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Details (top line)</label>
                            <input type="text" id="drpc-details" value="${esc(c.details)}" maxlength="128" placeholder="What you're doing"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">State (second line)</label>
                            <input type="text" id="drpc-state" value="${esc(c.state)}" maxlength="128" placeholder="More detail"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Large image key</label>
                            <input type="text" id="drpc-largeImageKey" value="${esc(c.largeImageKey)}" placeholder="asset name" spellcheck="false"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Large image tooltip</label>
                            <input type="text" id="drpc-largeImageText" value="${esc(c.largeImageText)}" maxlength="128" placeholder="hover text"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Small image key</label>
                            <input type="text" id="drpc-smallImageKey" value="${esc(c.smallImageKey)}" placeholder="asset name" spellcheck="false"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Small image tooltip</label>
                            <input type="text" id="drpc-smallImageText" value="${esc(c.smallImageText)}" maxlength="128" placeholder="hover text"
                                oninput="discordRpcOnEdit()"
                                class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                    </div>

                    <div class="border border-white/10 rounded-xl p-3">
                        <p class="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Buttons (up to 2)</p>
                        <div class="grid grid-cols-2 gap-2 mb-2">
                            <input type="text" id="drpc-btn0-label" value="${esc(b0.label)}" maxlength="32" placeholder="Button 1 label"
                                oninput="discordRpcOnEdit()"
                                class="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">
                            <input type="text" id="drpc-btn0-url" value="${esc(b0.url)}" placeholder="https://…" spellcheck="false"
                                oninput="discordRpcOnEdit()"
                                class="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <input type="text" id="drpc-btn1-label" value="${esc(b1.label)}" maxlength="32" placeholder="Button 2 label"
                                oninput="discordRpcOnEdit()"
                                class="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">
                            <input type="text" id="drpc-btn1-url" value="${esc(b1.url)}" placeholder="https://…" spellcheck="false"
                                oninput="discordRpcOnEdit()"
                                class="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-neutral-600 no-drag">
                        </div>
                    </div>

                    <label class="flex items-center gap-2.5 text-sm text-neutral-300 no-drag cursor-pointer">
                        <span class="ios-toggle">
                            <input type="checkbox" class="ios-toggle-input" id="drpc-showTimestamp" ${c.showTimestamp ? 'checked' : ''} onchange="discordRpcOnEdit()">
                            <span class="ios-toggle-track"></span>
                        </span>
                        Show elapsed time
                    </label>

                    <div>
                        <p class="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Live preview</p>
                        <div id="discord-rpc-preview">${discordRpcPreviewHtml()}</div>
                        <p class="text-[10px] text-neutral-600 mt-1">The bold top line is your Discord app’s own name (pulled from the Application ID) — it can’t be edited here. To change it, rename the app at
                            <button type="button" class="underline hover:text-neutral-400" onclick="discordRpcOpenPortal()">discord.com/developers</button>. Everything below it (details, state, images, buttons) is yours to edit.</p>
                    </div>

                    <div class="flex items-center gap-2">
                        <button type="button" onclick="discordRpcReconnect()"
                            class="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs transition-colors no-drag">
                            <i class="fas fa-rotate-right mr-1.5"></i>Reconnect</button>
                    </div>
                </div>`;

            startDiscordRpcPreviewClock();
        }

        function discordRpcStatusBadgeHtml() {
            const s = discordRpcState || {};
            let cls = 'bg-neutral-800/60 border-neutral-700/50 text-neutral-400';
            let icon = 'fa-circle';
            let text = 'Not connected';
            if (s.connected) {
                cls = 'bg-emerald-600/15 border-emerald-600/40 text-emerald-300';
                icon = 'fa-circle-check';
                text = 'Connected to Discord';
            } else if (s.error) {
                cls = 'bg-amber-600/15 border-amber-600/40 text-amber-300';
                icon = 'fa-triangle-exclamation';
                text = s.error;
            } else if (!s.hasClientId) {
                text = 'Add your Application ID to connect';
            } else {
                text = 'Connecting… (is Discord running?)';
            }
            return `<div class="flex items-center gap-2 text-xs border rounded-xl px-3 py-2 ${cls}">
                <i class="fas ${icon}"></i><span>${esc(text)}</span></div>`;
        }

        function discordRpcRenderStatusBadge() {
            const el = document.getElementById('discord-rpc-status-badge');
            if (el) el.innerHTML = discordRpcStatusBadgeHtml();
        }

        // Discord shows the FontAwesome-less version of a Rich Presence card; this
        // is a faithful-enough mock so the user sees exactly how their text lands.
        function discordRpcPreviewHtml() {
            const c = discordRpcCfg();
            const hasLarge = !!c.largeImageKey;
            const hasSmall = !!c.smallImageKey;
            const elapsed = c.showTimestamp ? discordRpcElapsedText() : '';
            // A key can be an uploaded Art Asset name OR a direct image URL. For a
            // URL we can render the real image so the preview matches the card;
            // for an asset name we can't resolve it, so we show a placeholder icon.
            const isUrl = (s) => /^https?:\/\//i.test(s || '');
            const large = hasLarge
                ? (isUrl(c.largeImageKey)
                    ? `<div class="drpc-prev-large" title="${esc(c.largeImageText)}"><img src="${esc(c.largeImageKey)}" alt="" class="drpc-prev-img"></div>`
                    : `<div class="drpc-prev-large" title="${esc(c.largeImageText)}"><i class="fas fa-image"></i></div>`)
                : `<div class="drpc-prev-large drpc-prev-empty"><i class="fas fa-image"></i></div>`;
            const small = hasSmall
                ? (isUrl(c.smallImageKey)
                    ? `<div class="drpc-prev-small" title="${esc(c.smallImageText)}"><img src="${esc(c.smallImageKey)}" alt="" class="drpc-prev-img"></div>`
                    : `<div class="drpc-prev-small" title="${esc(c.smallImageText)}"><i class="fas fa-circle-user"></i></div>`)
                : '';
            // The bold top line is the Discord application's own name (fetched from
            // the Application ID). It isn't editable and isn't part of the activity.
            const appName = (discordRpcState && discordRpcState.appName) || '';
            const lines = [
                appName
                    ? `<p class="drpc-prev-name">${esc(appName)}</p>`
                    : `<p class="drpc-prev-name drpc-prev-empty-name">Your app’s name</p>`
            ];
            if (c.details) lines.push(`<p class="drpc-prev-details">${esc(c.details)}</p>`);
            if (c.state) lines.push(`<p class="drpc-prev-state">${esc(c.state)}</p>`);
            if (elapsed) lines.push(`<p class="drpc-prev-time"><i class="fas fa-gamepad drpc-prev-time-icon"></i><span class="drpc-prev-time-val">${esc(elapsed)}</span></p>`);
            const btns = c.buttons.filter(b => b.label && b.url).map(b =>
                `<div class="drpc-prev-btn">${esc(b.label)}</div>`).join('');
            return `
                <div class="drpc-prev-card">
                    <p class="drpc-prev-header">Playing</p>
                    <div class="drpc-prev-body">
                        <div class="drpc-prev-art">${large}${small}</div>
                        <div class="drpc-prev-text">${lines.join('')}</div>
                    </div>
                    ${btns ? `<div class="drpc-prev-btns">${btns}</div>` : ''}
                </div>`;
        }

        function discordRpcElapsedText() {
            // The main process resets the clock on each (re)connect; for the preview
            // we just show a plausible running counter from when the panel opened.
            if (!discordRpcPreviewClock) discordRpcPreviewClock = { start: Date.now(), timer: null };
            const secs = Math.floor((Date.now() - discordRpcPreviewClock.start) / 1000);
            const m = Math.floor(secs / 60), s = secs % 60;
            // Match Discord's card: "M:SS" (no leading zero on minutes, no label).
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        function startDiscordRpcPreviewClock() {
            stopDiscordRpcPreviewClock();
            const c = discordRpcCfg();
            if (!c.showTimestamp) return;
            discordRpcPreviewClock = { start: Date.now(), timer: null };
            discordRpcPreviewClock.timer = setInterval(() => {
                const prev = document.getElementById('discord-rpc-preview');
                if (!prev) { stopDiscordRpcPreviewClock(); return; }
                const timeEl = prev.querySelector('.drpc-prev-time-val');
                if (timeEl) timeEl.textContent = discordRpcElapsedText();
            }, 1000);
        }

        function stopDiscordRpcPreviewClock() {
            if (discordRpcPreviewClock && discordRpcPreviewClock.timer) {
                clearInterval(discordRpcPreviewClock.timer);
            }
            discordRpcPreviewClock = null;
        }

        // Collects the form into a config object.
        function discordRpcCollect() {
            const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
            const buttons = [];
            for (const i of [0, 1]) {
                const label = val(`drpc-btn${i}-label`).trim();
                const url = val(`drpc-btn${i}-url`).trim();
                if (label && url) buttons.push({ label, url });
            }
            const showEl = document.getElementById('drpc-showTimestamp');
            return {
                clientId: val('drpc-clientId'),
                details: val('drpc-details'),
                state: val('drpc-state'),
                largeImageKey: val('drpc-largeImageKey'),
                largeImageText: val('drpc-largeImageText'),
                smallImageKey: val('drpc-smallImageKey'),
                smallImageText: val('drpc-smallImageText'),
                showTimestamp: showEl ? showEl.checked : true,
                buttons
            };
        }

        // Debounced save so typing doesn't hammer the pipe; the preview updates live.
        function discordRpcOnEdit() {
            // Update local cache immediately so the preview reflects keystrokes.
            if (discordRpcState) discordRpcState.config = { ...discordRpcState.config, ...discordRpcCollect() };
            const prevEl = document.getElementById('discord-rpc-preview');
            if (prevEl) prevEl.innerHTML = discordRpcPreviewHtml();
            startDiscordRpcPreviewClock();
            if (discordRpcSaveTimer) clearTimeout(discordRpcSaveTimer);
            discordRpcSaveTimer = setTimeout(async () => {
                discordRpcSaveTimer = null;
                if (!window.electronAPI?.discordRpcSetConfig) return;
                const state = await window.electronAPI.discordRpcSetConfig(discordRpcCollect());
                if (state) { discordRpcState = state; discordRpcRenderStatusBadge(); }
            }, 500);
        }

        async function discordRpcReconnect() {
            if (!window.electronAPI?.discordRpcReconnect) return;
            // Flush any pending edit first so we reconnect with the latest config.
            if (discordRpcSaveTimer) {
                clearTimeout(discordRpcSaveTimer);
                discordRpcSaveTimer = null;
                if (window.electronAPI?.discordRpcSetConfig) await window.electronAPI.discordRpcSetConfig(discordRpcCollect());
            }
            const state = await window.electronAPI.discordRpcReconnect();
            if (state) { discordRpcState = state; discordRpcRenderStatusBadge(); }
            showToast('Reconnecting to Discord…');
        }

        function discordRpcOpenPortal() {
            if (window.electronAPI?.openExternal) window.electronAPI.openExternal('https://discord.com/developers/applications');
        }
