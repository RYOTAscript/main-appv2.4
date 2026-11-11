        // ── Music player style (Settings → Spotify → Player Style) ──
        // One look for the whole player: the dashboard card and the full-screen
        // lyrics stage switch together. 'glass' is the original dark frosted look;
        // 'white' is a paper-white card with a clear vinyl sliding out of the album
        // sleeve, where orange only ever marks the playhead and liked songs. The
        // corner player keeps its own style (Widget Library → Corner Player).
        // Styling lives in styles/player-style.css; this file only flips classes.
        const PLAYER_STYLES = ['glass', 'white'];
        const PLAYER_STYLE_KEY = 'spotifyPlayerStyle';
        const SPOTIFY_DISK_IMAGE = 'icons/player.png';
        // A transparent pixel for "no cover": the paper label painted underneath
        // shows through. Dropping src instead makes Chromium draw a broken-image
        // icon in the middle of the record, even with alt="".
        const BLANK_LABEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

        function getSpotifyPlayerStyle() {
            const stored = localStorage.getItem(PLAYER_STYLE_KEY);
            return PLAYER_STYLES.includes(stored) ? stored : 'glass';
        }

        function isWhitePlayerStyle() {
            return getSpotifyPlayerStyle() === 'white';
        }

        // White puts the album art on the record's centre label, so the spinning
        // disk shows the cover instead of the bundled vinyl image. The disk keeps
        // its id, its rotation loop and its beat glow — only what it paints
        // changes. The sleeve (#spotify-album-cover) is the source of truth for
        // which cover is current, so the label always matches the sleeve beside it.
        function syncSpotifyDiskArt() {
            const disk = document.getElementById('spotify-disk');
            if (!disk) return;
            if (!isWhitePlayerStyle()) {
                if (disk.getAttribute('src') !== SPOTIFY_DISK_IMAGE) disk.src = SPOTIFY_DISK_IMAGE;
                return;
            }
            // The clear vinyl is drawn in CSS, so it shows even when the bundled
            // image is missing and Glass had to fall back to a stand-in.
            if (disk.style.display === 'none') disk.style.display = '';
            const sleeve = document.getElementById('spotify-album-cover');
            const art = sleeve && sleeve.style.display !== 'none' ? sleeve.getAttribute('src') : '';
            const label = art && art !== disk.dataset.failedSrc ? art : BLANK_LABEL;
            if (disk.getAttribute('src') !== label) disk.src = label;
        }

        // #spotify-disk's onerror.
        function spotifyDiskImageError(img) {
            if (isWhitePlayerStyle()) {
                // A cover that won't load leaves a blank label — and is not
                // retried on the next sync.
                if (img.getAttribute('src') === BLANK_LABEL) return;
                img.dataset.failedSrc = img.getAttribute('src') || '';
                img.src = BLANK_LABEL;
                return;
            }
            // Glass: the bundled vinyl image itself is missing — draw a stand-in.
            img.style.display = 'none';
            if (!img.nextElementSibling || !img.nextElementSibling.classList.contains('vinyl-fallback')) {
                img.insertAdjacentHTML('afterend', '<div class="vinyl-fallback w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center vinyl-disk"><i class="fab fa-spotify text-3xl text-neutral-600"></i></div>');
            }
        }

        // Every [data-player-style] button reflects the current choice: the
        // picker in Settings and the style row in the Full Screen Lyrics panel.
        function renderPlayerStylePicker() {
            const current = getSpotifyPlayerStyle();
            document.querySelectorAll('[data-player-style]').forEach(btn => {
                const on = btn.dataset.playerStyle === current;
                btn.classList.toggle('is-active', on);
                btn.setAttribute('aria-checked', on ? 'true' : 'false');
            });
        }

        function applySpotifyPlayerStyle() {
            const white = isWhitePlayerStyle();
            document.getElementById('widget-spotify')?.classList.toggle('player-white', white);
            document.getElementById('fullscreen-lyrics')?.classList.toggle('player-white', white);
            syncSpotifyDiskArt();
            renderPlayerStylePicker();
            // The Full Screen Lyrics panel shows the look too (no-op unless open).
            if (typeof renderFullscreenLyricsPanel === 'function') renderFullscreenLyricsPanel();
            // And the phone remote follows it.
            if (typeof pushPhoneRemoteSync === 'function') pushPhoneRemoteSync();
        }

        function setSpotifyPlayerStyle(style) {
            if (!PLAYER_STYLES.includes(style)) return;
            if (style !== getSpotifyPlayerStyle()) {
                localStorage.setItem(PLAYER_STYLE_KEY, style);
                scheduleSettingsSave();
            }
            applySpotifyPlayerStyle();
        }

        // Applied as soon as this script runs (the player markup is already
        // parsed), so the chosen look is in place before the dashboard reveals.
        applySpotifyPlayerStyle();
