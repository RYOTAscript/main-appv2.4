        // ── Parallax effect (Settings → Appearance, OFF by default) ──
        // When enabled, the window gains a sense of depth as the mouse moves:
        // the background scene and grid drift slightly *away* from the cursor
        // (far layer) while the Quick Launch icons and widget cards lean gently
        // *toward* it (near layer). Motion is spring-smoothed in a rAF loop that
        // only runs while the layers are actually moving — when everything has
        // settled the loop stops, so an idle window costs nothing.
        //
        // Modals, the header, and the footer are intentionally NOT parallaxed —
        // UI you're interacting with must stay still under the cursor.

        const PARALLAX_KEY = 'parallaxEnabled';
        // How strongly each layer follows the cursor, in px at full deflection.
        // `tilt` is the whole panel's max lean, in degrees — kept small (and the
        // perspective distant) because rotated text can never be perfectly sharp;
        // at ~1° the softness is imperceptible.
        const PARALLAX_DEPTHS = { bgX: 10, bgY: 8, gridX: 16, gridY: 12, appsX: 4, appsY: 3, widgetsX: 5, widgetsY: 4, tilt: 1.1 };
        const PARALLAX_EASE_TRACK = 0.09;    // lerp per frame while following the cursor
        const PARALLAX_EASE_RETURN = 0.03;   // much floatier drift back to center
        const PARALLAX_SETTLE = 0.001;       // treat deltas below this as "arrived"

        let parallaxOn = false;
        let parallaxRaf = null;
        let parallaxTX = 0, parallaxTY = 0;  // target position, normalized -1..1
        let parallaxCX = 0, parallaxCY = 0;  // current (smoothed) position
        let parallaxEase = PARALLAX_EASE_TRACK;
        let parallaxTiltReady = false;       // startup fade-in released yet?

        function parallaxLayers() {
            return {
                win: document.getElementById('main-window'),
                bg: document.querySelector('.bg-scene'),
                grid: document.querySelector('.grid-overlay'),
                apps: document.getElementById('apps-grid'),
                widgets: document.getElementById('widgets-row')
            };
        }

        function parallaxApply() {
            const d = PARALLAX_DEPTHS;
            const { win, bg, grid, apps, widgets } = parallaxLayers();
            // The whole panel leans toward the cursor: the corner under the mouse
            // lifts slightly toward the viewer (rotateY is negated because a
            // positive CSS rotateY pushes the right edge *away*).
            // The startup .fade-in animation fills forwards, which pins the
            // panel's transform and would silently swallow the tilt — release it
            // once, on the first real tilt (its final frame equals the natural
            // state, so removing it changes nothing visually).
            if (win) {
                if (!parallaxTiltReady) {
                    win.classList.remove('fade-in');
                    parallaxTiltReady = true;
                }
                win.style.transform = `perspective(1800px) rotateX(${(parallaxCY * d.tilt).toFixed(3)}deg) rotateY(${(-parallaxCX * d.tilt).toFixed(3)}deg)`;
            }
            // The slight scale keeps the background's edges covered while it
            // translates; without it a sliver of empty window would peek through.
            // (Fractional offsets are fine here — it's a soft gradient.)
            if (bg) bg.style.transform = `translate3d(${(-parallaxCX * d.bgX).toFixed(2)}px, ${(-parallaxCY * d.bgY).toFixed(2)}px, 0) scale(1.045)`;
            // The grid can't be transform-parallaxed — its gridDrift keyframes own
            // the transform — so its background-position shifts instead, which the
            // drift animation doesn't touch. Whole pixels only: a fractional
            // offset smears the 1px grid lines across two pixels (visible blur).
            if (grid) grid.style.backgroundPosition = `${Math.round(-parallaxCX * d.gridX)}px ${Math.round(-parallaxCY * d.gridY)}px`;
            // Foreground layers carry text — whole pixels only, same reason.
            if (apps) apps.style.transform = `translate3d(${Math.round(parallaxCX * d.appsX)}px, ${Math.round(parallaxCY * d.appsY)}px, 0)`;
            if (widgets) widgets.style.transform = `translate3d(${Math.round(parallaxCX * d.widgetsX)}px, ${Math.round(parallaxCY * d.widgetsY)}px, 0)`;
        }

        function parallaxClear() {
            const { win, bg, grid, apps, widgets } = parallaxLayers();
            if (win) win.style.transform = '';
            if (bg) bg.style.transform = '';
            if (grid) grid.style.backgroundPosition = '';
            if (apps) apps.style.transform = '';
            if (widgets) widgets.style.transform = '';
        }

        function parallaxTick() {
            parallaxCX += (parallaxTX - parallaxCX) * parallaxEase;
            parallaxCY += (parallaxTY - parallaxCY) * parallaxEase;
            if (Math.abs(parallaxTX - parallaxCX) < PARALLAX_SETTLE && Math.abs(parallaxTY - parallaxCY) < PARALLAX_SETTLE) {
                parallaxCX = parallaxTX;
                parallaxCY = parallaxTY;
                // Settled at dead center = drop every inline transform. A 3D-
                // transformed panel is composited off its own rasterized layer,
                // which renders text slightly soft even at 0° — clearing it
                // returns the app to normal, pixel-perfect rendering at rest.
                if (parallaxTX === 0 && parallaxTY === 0) parallaxClear();
                else parallaxApply();
                parallaxRaf = null;         // settled — stop the loop until new input
                return;
            }
            parallaxApply();
            parallaxRaf = requestAnimationFrame(parallaxTick);
        }

        function parallaxKick() {
            if (!parallaxRaf) parallaxRaf = requestAnimationFrame(parallaxTick);
        }

        window.addEventListener('mousemove', (e) => {
            if (!parallaxOn) return;
            const win = document.getElementById('main-window');
            if (!win) return;
            const rect = win.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            parallaxEase = PARALLAX_EASE_TRACK;
            parallaxTX = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
            parallaxTY = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
            parallaxKick();
        });

        // Cursor left the window (or focus moved to another app) — drift slowly
        // back to center with the floatier return ease.
        function parallaxReturnToCenter() {
            if (!parallaxOn) return;
            parallaxEase = PARALLAX_EASE_RETURN;
            parallaxTX = 0;
            parallaxTY = 0;
            parallaxKick();
        }

        document.documentElement.addEventListener('mouseleave', parallaxReturnToCenter);
        window.addEventListener('blur', parallaxReturnToCenter);

        // Reads the stored preference and starts/stops the effect to match.
        function applyParallaxPref() {
            parallaxOn = localStorage.getItem(PARALLAX_KEY) === 'true';
            if (!parallaxOn) {
                if (parallaxRaf) {
                    cancelAnimationFrame(parallaxRaf);
                    parallaxRaf = null;
                }
                parallaxTX = parallaxTY = parallaxCX = parallaxCY = 0;
                parallaxClear();
            }
        }

        function saveParallaxPref() {
            const cb = document.getElementById('parallax-toggle');
            localStorage.setItem(PARALLAX_KEY, cb && cb.checked ? 'true' : 'false');
            applyParallaxPref();
            scheduleSettingsSave();
        }

        function loadParallaxPref() {
            const cb = document.getElementById('parallax-toggle');
            if (cb) cb.checked = localStorage.getItem(PARALLAX_KEY) === 'true';
        }

        applyParallaxPref();
