        // ── Phone Remote ────────────────────────────────────────────────────
        // The player and lyrics on a phone, from anywhere. main/phoneRemote.js
        // pairs phones, holds the relay connection and polls Spotify for them;
        // the phone page lives on the website (website/public/remote/). This
        // file is only the Widget Library panel — status, the pairing QR code
        // (renderer/qr-code.js), unpairing — plus the two things main can't see
        // on its own: the player look and the lyrics timing offset.

        let phoneRemoteInfo = null;
        let phoneRemoteLink = null;        // only while the pairing code is on screen
        let phoneRemoteConfirmUnpair = false;

        // Called from applyMiniWidgetPrefs() when the widget toggle flips (and on boot).
        function applyPhoneRemoteEnabled(enabled) {
            if (!window.electronAPI?.phoneRemoteSetEnabled) return;
            window.electronAPI.phoneRemoteSetEnabled(!!enabled).then((p) => {
                if (p && typeof p === 'object' && 'enabled' in p) phoneRemoteInfo = p;
                if (!enabled) phoneRemoteLink = null;
                renderPhoneRemotePanel();
            }).catch(() => {});
            if (enabled) pushPhoneRemoteSync();
        }

        // The player look (renderer/player-style.js) and "Lyrics Timing"
        // (renderer/settings.js), so the phone matches the launcher.
        function pushPhoneRemoteSync() {
            if (!window.electronAPI?.phoneRemoteSync) return;
            const look = typeof getSpotifyPlayerStyle === 'function' ? getSpotifyPlayerStyle() : 'glass';
            const lead = typeof getLyricsAnticipateMs === 'function' ? getLyricsAnticipateMs() : 700;
            window.electronAPI.phoneRemoteSync({ look, lead }).catch(() => {});
        }

        async function phoneRemoteShowPairing() {
            if (!window.electronAPI?.phoneRemotePair) return;
            try {
                const p = await window.electronAPI.phoneRemotePair();
                if (p && typeof p === 'object') {
                    phoneRemoteInfo = p;
                    phoneRemoteLink = typeof p.link === 'string' ? p.link : null;
                }
            } catch (e) { /* main logs it */ }
            renderPhoneRemotePanel();
        }

        function phoneRemoteHidePairing() {
            phoneRemoteLink = null;
            renderPhoneRemotePanel();
        }

        async function phoneRemoteCopyLink() {
            if (!phoneRemoteLink) return;
            try {
                await navigator.clipboard.writeText(phoneRemoteLink);
                if (typeof showToast === 'function') showToast('Link copied. Anyone with it can control your music, so send it only to yourself.');
            } catch (e) {
                if (typeof showToast === 'function') showToast('Couldn’t copy the link', true);
            }
        }

        // Two clicks: the first arms it, so a stray click can't cut every phone off.
        async function phoneRemoteUnpair() {
            if (!phoneRemoteConfirmUnpair) {
                phoneRemoteConfirmUnpair = true;
                renderPhoneRemotePanel();
                setTimeout(() => { phoneRemoteConfirmUnpair = false; renderPhoneRemotePanel(); }, 4000);
                return;
            }
            phoneRemoteConfirmUnpair = false;
            phoneRemoteLink = null;
            try {
                const p = await window.electronAPI.phoneRemoteUnpair();
                if (p && typeof p === 'object') phoneRemoteInfo = p;
                if (typeof showToast === 'function') showToast('All phones unpaired');
            } catch (e) { /* main logs it */ }
            renderPhoneRemotePanel();
        }

        function phoneRemoteStatusLine(p) {
            if (!p.enabled) return { tone: 'off', text: 'Off — turn the widget on to use it' };
            switch (p.status) {
                case 'unconfigured': return { tone: 'warn', text: 'Not set up in this build yet' };
                case 'unpaired': return { tone: 'idle', text: 'No phone paired yet' };
                case 'unlicensed': return { tone: 'warn', text: 'Needs an active license' };
                case 'connecting': return { tone: 'busy', text: 'Connecting…' };
                case 'online':
                    return p.phones > 0
                        ? { tone: 'live', text: `${p.phones} phone${p.phones === 1 ? '' : 's'} connected` }
                        : { tone: 'ok', text: 'Ready — open the remote on your phone' };
                case 'offline': return { tone: 'busy', text: 'Can’t reach the relay — retrying' };
                case 'error': return { tone: 'warn', text: 'Something went wrong — restart main' };
                default: return { tone: 'off', text: 'Off' };
            }
        }

        // ── Config panel (Widget Library detail view) ───────────────────────────
        // No-ops unless its div is on screen (only present while the detail is open).
        function renderPhoneRemotePanel() {
            const panel = document.getElementById('phone-remote-panel');
            if (!panel) return;
            const p = phoneRemoteInfo || { enabled: false, paired: false, configured: true, status: 'off', phones: 0 };
            const line = phoneRemoteStatusLine(p);
            const connected = typeof spotifyConnectionState === 'undefined' || spotifyConnectionState === 'connected';

            let qr = '';
            if (phoneRemoteLink && typeof QRCode !== 'undefined') {
                try {
                    const code = QRCode.encode(phoneRemoteLink, 'M');
                    const side = code.size + 8;
                    // Path data is built from the matrix alone; the link never touches markup.
                    qr = `<svg class="pr-qr-svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="Pairing code">` +
                        `<rect width="${side}" height="${side}" fill="#fff"/><path d="${QRCode.svgPath(code)}" fill="#000"/></svg>`;
                } catch (e) {
                    qr = '';
                }
            }

            let body = '';
            if (!p.enabled) {
                body = '';
            } else if (!p.configured) {
                body = `<div class="fsl-cfg-note"><i class="fas fa-triangle-exclamation"></i>` +
                    `<span>This build doesn’t have the relay address yet, so it can’t reach a phone. Update main to get it.</span></div>`;
            } else if (qr) {
                body =
                    `<div class="pr-pair">` +
                        `<div class="pr-qr">${qr}</div>` +
                        `<ol class="pr-steps">` +
                            `<li>Point your phone’s camera at the code.</li>` +
                            `<li>Tap the link that appears. The player opens in your browser.</li>` +
                            `<li>On an iPhone, tap <b>Share</b> → <b>Add to Home Screen</b> to keep it like an app.</li>` +
                        `</ol>` +
                    `</div>` +
                    `<div class="pr-actions">` +
                        `<button type="button" class="fsl-cfg-open no-drag" onclick="phoneRemoteHidePairing()"><i class="fas fa-check"></i> Done</button>` +
                        `<button type="button" class="pr-link-btn no-drag" onclick="phoneRemoteCopyLink()"><i class="fas fa-link"></i> Copy link</button>` +
                    `</div>`;
            } else if (!p.paired) {
                body = `<button type="button" class="fsl-cfg-open no-drag" onclick="phoneRemoteShowPairing()">` +
                    `<i class="fas fa-qrcode"></i> Pair a phone</button>`;
            } else {
                body =
                    `<div class="pr-actions">` +
                        `<button type="button" class="fsl-cfg-open no-drag" onclick="phoneRemoteShowPairing()"><i class="fas fa-qrcode"></i> Add another phone</button>` +
                        `<button type="button" class="pr-link-btn pr-danger no-drag" onclick="phoneRemoteUnpair()">` +
                            (phoneRemoteConfirmUnpair ? 'Click again to unpair' : 'Unpair all phones') + `</button>` +
                    `</div>`;
            }

            panel.innerHTML =
                `<div class="fsl-cfg">` +
                    (connected || !p.enabled ? '' :
                        `<div class="fsl-cfg-note"><i class="fas fa-triangle-exclamation"></i>` +
                        `<span>Connect <b>Spotify</b> first (Settings ▸ Spotify). The remote shows whatever Spotify is playing.</span></div>`) +
                    `<div class="pr-status pr-${line.tone}"><span class="pr-dot"></span><span>${line.text}</span></div>` +
                    body +
                    `<p class="fsl-cfg-hint">Works anywhere your phone and PC are online, not just on the same Wi-Fi. ` +
                        `They talk end-to-end encrypted through main’s relay, which can’t see what you play. ` +
                        `The code is the key: anyone who scans it can control your music until you unpair.</p>` +
                `</div>`;
        }

        // ── Messages from main ──────────────────────────────────────────────────
        window.electronAPI?.onPhoneRemoteChanged?.((p) => {
            if (p && typeof p === 'object') {
                const firstPhone = phoneRemoteLink && p.phones > 0;
                phoneRemoteInfo = p;
                // The phone that just scanned is in: the code has done its job.
                if (firstPhone) phoneRemoteLink = null;
                renderPhoneRemotePanel();
            }
        });

        window.electronAPI?.phoneRemoteGet?.().then((p) => {
            if (p && typeof p === 'object' && 'enabled' in p) phoneRemoteInfo = p;
            renderPhoneRemotePanel();
        }).catch(() => {});
        setTimeout(pushPhoneRemoteSync, 0);
