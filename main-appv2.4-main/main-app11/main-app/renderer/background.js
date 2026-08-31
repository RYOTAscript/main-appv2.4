        // ── Background Studio ──
        // Full background customisation (Settings → Background): built-in animated
        // scenes (CSS gradient/blob presets + canvas particle scenes), the user's
        // own images/GIFs/videos (copied to %APPDATA%/main-launcher/backgrounds by
        // main/backgrounds.js), and a set of live effects — blur, brightness,
        // saturation, animation speed, film grain, vignette, plus the existing
        // grid/scanline overlays and a "panel glass" transparency control that
        // drives the .glass alpha for real frosted-glass widgets.
        //
        // Layering and per-preset colors live in styles/backgrounds.css; this file
        // only decides WHICH preset/media/effects are active and runs the canvas
        // scenes. Everything persists in one localStorage JSON blob so it rides
        // along with settings export/import.

        const BG_SETTINGS_KEY = 'backgroundSettings';

        const BG_DEFAULTS = {
            preset: 'mono',          // built-in preset id, 'diy', or 'custom' when media is set
            customFile: null,        // filename inside the backgrounds folder
            customType: null,        // 'image' | 'video'
            mediaFit: 'cover',       // custom media object-fit: cover | contain | fill
            blur: 0,                 // px, 0–40
            brightness: 100,         // %, 40–140
            saturation: 100,         // %, 0–160
            speed: 1,                // animation speed multiplier, 0.25–2
            grain: false,
            vignette: false,
            grid: true,              // the app's original overlays stay on by default
            scanlines: true,
            glass: 88,               // .glass panel alpha in %, 40–96
            theme: 'auto',           // accent theme id, 'auto' follows the background
            customAccent: '#38bdf8', // used when theme === 'custom'
            textTheme: 'white',      // text color id, 'auto' follows the accent theme
            customText: '#f5ead8',   // used when textTheme === 'custom'
            diyColors: ['#22d3ee', '#a78bfa', '#f472b6'],  // "My Scene" builder colors
            diyBlobs: true           // "My Scene": drifting color blobs on/off
        };

        // Built-in scenes. `canvas` names a particle scene rendered on #bg-canvas
        // on top of the preset's CSS gradients. `accent` is the color the 'auto'
        // theme adopts while that scene is active.
        const BG_PRESETS = [
            { id: 'mono', name: 'Monochrome', accent: '#ffffff' },
            { id: 'clear', name: 'Transparent', accent: '#ffffff' },
            { id: 'aurora', name: 'Aurora', accent: '#2dd4bf' },
            { id: 'prism', name: 'Prism', accent: '#a78bfa' },
            { id: 'nebula', name: 'Nebula', canvas: 'stars', accent: '#c084fc' },
            { id: 'sunset', name: 'Sunset', accent: '#fb923c' },
            { id: 'ocean', name: 'Ocean', accent: '#38bdf8' },
            { id: 'bokeh', name: 'Bokeh', canvas: 'bokeh', accent: '#fcd34d' },
            { id: 'diy', name: 'My Scene' }   // accent derives from the user's colors
        ];

        // Accent themes (Settings → Background → Accent theme). 'auto' follows the
        // active background; 'custom' uses the color-picker swatch.
        const BG_THEMES = [
            { id: 'auto', name: 'Auto — match background' },
            { id: 'frost', name: 'Frost', accent: '#ffffff' },
            { id: 'emerald', name: 'Emerald', accent: '#34d399' },
            { id: 'ice', name: 'Ice', accent: '#38bdf8' },
            { id: 'violet', name: 'Violet', accent: '#a78bfa' },
            { id: 'rose', name: 'Rose', accent: '#fb7185' },
            { id: 'amber', name: 'Amber', accent: '#fbbf24' },
            { id: 'crimson', name: 'Crimson', accent: '#f87171' }
        ];

        // Text color themes. All soft near-white tints — text sits on near-black,
        // so anything stronger would hurt readability; darker custom picks get
        // brightened by bgTextify. 'white' is the app's original palette.
        const BG_TEXT_THEMES = [
            { id: 'auto', name: 'Auto — match accent theme' },
            { id: 'white', name: 'White (default)', color: '#ffffff' },
            { id: 'cream', name: 'Cream', color: '#f5ead8' },
            { id: 'mint', name: 'Mint', color: '#dcf5ea' },
            { id: 'sky', name: 'Sky', color: '#dbeafe' },
            { id: 'lilac', name: 'Lilac', color: '#ece5fb' },
            { id: 'rose', name: 'Rose', color: '#fbe3ec' },
            { id: 'gold', name: 'Gold', color: '#f8e7bf' }
        ];

        // ── Color helpers ──

        function bgHexToRgb(hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
            if (!m) return null;
            const n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }

        function bgRgba(hex, alpha) {
            const rgb = bgHexToRgb(hex) || [255, 255, 255];
            return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
        }

        // Nudges any color into a usable accent: glows and thin bars need enough
        // lightness to read against the near-black theme, so very dark picks get
        // lifted while hue/saturation are kept.
        function bgAccentify(hex) {
            const rgb = bgHexToRgb(hex);
            if (!rgb) return '#ffffff';
            let [r, g, b] = rgb.map(v => v / 255);
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h = 0, l = (max + min) / 2;
            let s = max === min ? 0 : (max - min) / (l > 0.5 ? (2 - max - min) : (max + min));
            if (max !== min) {
                if (max === r) h = ((g - b) / (max - min) + (g < b ? 6 : 0)) / 6;
                else if (max === g) h = ((b - r) / (max - min) + 2) / 6;
                else h = ((r - g) / (max - min) + 4) / 6;
            }
            l = Math.max(l, 0.58);
            s = Math.min(s, 0.9);
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            let out;
            if (s === 0) out = [l, l, l];
            else {
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                out = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
            }
            return '#' + out.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        }

        // Same idea for TEXT colors, but much stricter: body text on a near-black
        // app must stay bright and only lightly tinted, so lightness is lifted to
        // ≥0.82 and saturation capped low. Any color the user picks comes out as
        // a readable pastel of that hue.
        function bgTextify(hex) {
            const rgb = bgHexToRgb(hex);
            if (!rgb) return '#ffffff';
            const accentified = bgAccentify(hex);
            const [r, g, b] = bgHexToRgb(accentified).map(v => v / 255);
            // Blend the (already brightened) color most of the way toward white.
            const toHex = (v) => Math.round((v * 0.45 + 0.55) * 255).toString(16).padStart(2, '0');
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }

        function getBgSettings() {
            const stored = safeParseJSON(localStorage.getItem(BG_SETTINGS_KEY), {});
            return { ...BG_DEFAULTS, ...stored };
        }

        function setBgSettings(patch) {
            const next = { ...getBgSettings(), ...patch };
            localStorage.setItem(BG_SETTINGS_KEY, JSON.stringify(next));
            return next;
        }

        function bgMediaUrl(fileName) {
            const base = window.electronAPI?.backgroundsBasePath;
            if (!base || !fileName) return '';
            return iconFileUrl(`${base}\\${fileName}`);
        }

        // ══════════════════════════════════════════════════════════════
        // Canvas particle scenes
        // ══════════════════════════════════════════════════════════════

        let bgCanvasMode = null;      // 'stars' | 'bokeh' | null
        let bgCanvasRaf = null;
        let bgCanvasParticles = [];
        let bgCanvasLastTs = 0;
        let bgSpeedFactor = 1;

        function bgCanvasSetup(canvas) {
            // The window is fixed-size, so sizing once per scene start is enough.
            // DPR capped: particle scenes are soft glows — full retina res would
            // double the GPU cost for no visible gain.
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const w = canvas.clientWidth || 1;
            const h = canvas.clientHeight || 1;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            return { ctx, w, h };
        }

        function bgSpawnStars(w, h) {
            const stars = [];
            for (let i = 0; i < 110; i++) {
                stars.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    r: 0.4 + Math.random() * 1.1,
                    alpha: 0.25 + Math.random() * 0.6,
                    twinkle: 0.4 + Math.random() * 1.6,   // rad/s
                    phase: Math.random() * Math.PI * 2,
                    vx: -1.2 - Math.random() * 2.2,       // px/s — slow drift left
                    vy: 0.4 + Math.random() * 1.0
                });
            }
            return stars;
        }

        function bgDrawStars(ctx, w, h, t, dt) {
            ctx.clearRect(0, 0, w, h);
            for (const s of bgCanvasParticles) {
                s.x += s.vx * dt;
                s.y += s.vy * dt;
                if (s.x < -4) s.x = w + 4;
                if (s.y > h + 4) s.y = -4;
                const a = s.alpha * (0.55 + 0.45 * Math.sin(t * s.twinkle + s.phase));
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(214, 224, 255, ${a.toFixed(3)})`;
                ctx.fill();
                // The few biggest stars get a soft halo so the field reads as depth.
                if (s.r > 1.25) {
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r * 3.2, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(190, 205, 255, ${(a * 0.16).toFixed(3)})`;
                    ctx.fill();
                }
            }
        }

        const BG_BOKEH_TINTS = [
            [255, 196, 128],   // warm amber
            [255, 238, 214],   // soft warm white
            [186, 202, 255],   // cool counterpoint
            [255, 214, 165]
        ];

        function bgSpawnBokeh(w, h) {
            const orbs = [];
            for (let i = 0; i < 16; i++) {
                const tint = BG_BOKEH_TINTS[i % BG_BOKEH_TINTS.length];
                orbs.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    r: 22 + Math.random() * 58,
                    tint,
                    alpha: 0.035 + Math.random() * 0.06,
                    vx: (Math.random() - 0.5) * 9,
                    vy: (Math.random() - 0.5) * 7,
                    pulse: 0.15 + Math.random() * 0.35,
                    phase: Math.random() * Math.PI * 2
                });
            }
            return orbs;
        }

        function bgDrawBokeh(ctx, w, h, t, dt) {
            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';
            for (const o of bgCanvasParticles) {
                o.x += o.vx * dt;
                o.y += o.vy * dt;
                // Drift through and wrap with margin so orbs never pop at the edges.
                const m = o.r + 10;
                if (o.x < -m) o.x = w + m; else if (o.x > w + m) o.x = -m;
                if (o.y < -m) o.y = h + m; else if (o.y > h + m) o.y = -m;
                const a = o.alpha * (0.7 + 0.3 * Math.sin(t * o.pulse + o.phase));
                const [r, g, b] = o.tint;
                const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
                grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`);
                grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${(a * 0.45).toFixed(3)})`);
                grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalCompositeOperation = 'source-over';
        }

        function bgCanvasTick(ts) {
            const canvas = document.getElementById('bg-canvas');
            if (!canvas || !bgCanvasMode) { bgCanvasRaf = null; return; }
            const ctx = canvas.getContext('2d');
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            // Clamp dt so a long pause (minimised window) doesn't teleport particles.
            const dt = Math.min((ts - bgCanvasLastTs) / 1000 || 0.016, 0.1) * bgSpeedFactor;
            bgCanvasLastTs = ts;
            const t = (ts / 1000) * bgSpeedFactor;
            if (bgCanvasMode === 'stars') bgDrawStars(ctx, w, h, t, dt);
            else if (bgCanvasMode === 'bokeh') bgDrawBokeh(ctx, w, h, t, dt);
            bgCanvasRaf = requestAnimationFrame(bgCanvasTick);
        }

        function bgCanvasStart(mode) {
            const canvas = document.getElementById('bg-canvas');
            if (!canvas) return;
            bgCanvasStop();
            // Show it BEFORE measuring — a display:none canvas has clientWidth 0.
            canvas.classList.add('bg-active');
            const { w, h } = bgCanvasSetup(canvas);
            bgCanvasMode = mode;
            bgCanvasParticles = mode === 'stars' ? bgSpawnStars(w, h) : bgSpawnBokeh(w, h);
            bgCanvasLastTs = performance.now();
            bgCanvasRaf = requestAnimationFrame(bgCanvasTick);
        }

        function bgCanvasStop() {
            if (bgCanvasRaf) cancelAnimationFrame(bgCanvasRaf);
            bgCanvasRaf = null;
            bgCanvasMode = null;
            bgCanvasParticles = [];
            document.getElementById('bg-canvas')?.classList.remove('bg-active');
        }

        // Hidden window (minimised/tray) — stop burning frames on a canvas and a
        // video nobody can see; resume where they left off when shown again.
        document.addEventListener('visibilitychange', () => {
            const video = document.getElementById('bg-video');
            if (document.hidden) {
                if (bgCanvasRaf) { cancelAnimationFrame(bgCanvasRaf); bgCanvasRaf = null; }
                if (video && !video.paused) video.pause();
            } else {
                if (bgCanvasMode && !bgCanvasRaf) {
                    bgCanvasLastTs = performance.now();
                    bgCanvasRaf = requestAnimationFrame(bgCanvasTick);
                }
                if (video && video.classList.contains('bg-active')) video.play().catch(() => {});
            }
            // The live screen capture is NOT torn down on every flip — see
            // BG_LIVE_HIDE_GRACE_MS. Only a sustained absence promotes this to
            // "deeply hidden" and lets applyBackground stop the capture; coming
            // back before then cancels the pending stop, so an alt-tab round
            // trip never restarts the stream.
            clearTimeout(bgHideGraceTimer);
            bgHideGraceTimer = null;
            if (document.hidden) {
                bgHideGraceTimer = setTimeout(() => {
                    bgHideGraceTimer = null;
                    bgDeepHidden = true;
                    if (getBgSettings().preset === 'clear') applyBackground();
                }, BG_LIVE_HIDE_GRACE_MS);
            } else {
                bgDeepHidden = false;
            }
            if (getBgSettings().preset === 'clear') applyBackground();
        });

        // ══════════════════════════════════════════════════════════════
        // Accent theme
        // ══════════════════════════════════════════════════════════════

        // Read by renderer/beat-glow.js every frame for the disk pulse color —
        // a shared global is much cheaper than getComputedStyle per frame.
        let bgAccentRgbStr = '255, 255, 255';

        // Dominant color sampled from the user's own media, keyed by filename so
        // switching back and forth doesn't resample.
        const bgMediaAccentCache = {};

        // Averages the media's pixels on a tiny canvas, weighted toward colorful,
        // reasonably bright pixels so one red neon sign wins over a grey wall.
        // Returns null when the color can't be read (e.g. the canvas is tainted
        // by file:// origin rules) — callers fall back to white. An optional
        // source rect samples just that part of the element (used to sample
        // only the window's area of the live screen stream).
        let bgSampleCanvas = null;
        function bgSampleMediaColor(el, rect) {
            try {
                // Reused across calls — the live sampler runs every few
                // seconds, and a fresh canvas per tick is needless GC churn.
                if (!bgSampleCanvas) {
                    bgSampleCanvas = document.createElement('canvas');
                    bgSampleCanvas.width = 32;
                    bgSampleCanvas.height = 20;
                }
                const ctx = bgSampleCanvas.getContext('2d', { willReadFrequently: true });
                ctx.clearRect(0, 0, 32, 20);
                if (rect) ctx.drawImage(el, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, 32, 20);
                else ctx.drawImage(el, 0, 0, 32, 20);
                const data = ctx.getImageData(0, 0, 32, 20).data;
                let r = 0, g = 0, b = 0, wSum = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const pr = data[i], pg = data[i + 1], pb = data[i + 2];
                    const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
                    // saturation × brightness, so both grey and near-black weigh ~0
                    const w = ((max - min) / 255) * (max / 255) + 0.02;
                    r += pr * w; g += pg * w; b += pb * w; wSum += w;
                }
                if (!wSum) return null;
                const toHex = (v) => Math.round(v / wSum).toString(16).padStart(2, '0');
                return bgAccentify(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
            } catch (e) {
                return null;   // tainted canvas or decode failure — theme stays white
            }
        }

        // Called from the media elements' load events: with the Auto theme active,
        // the accent re-tints to the newly loaded background's dominant color.
        function bgOnMediaReady(el) {
            const s = getBgSettings();
            if (s.preset !== 'custom' || !s.customFile) return;
            if (!(s.customFile in bgMediaAccentCache)) {
                bgMediaAccentCache[s.customFile] = bgSampleMediaColor(el);
            }
            if (s.theme === 'auto') bgApplyTheme(s);
        }

        // ── Auto theme on Transparent: follow what's REALLY behind the app ──
        // The main process samples the screen around the window (its own UI
        // carries little weight thanks to the outward padding + saturation
        // weighting) and returns the dominant color. While the Transparent
        // preset is active with the Auto accent or Auto text color, it's
        // re-sampled every few seconds and after every window drag, so the
        // theme keeps tracking whatever is actually visible behind the app.
        let bgBehindColor = null;   // accentified hex of the last sample
        let bgBehindTimer = null;
        let bgBehindBusy = false;

        function bgBehindSamplingWanted(s) {
            return s.preset === 'clear' && (s.theme === 'auto' || s.textTheme === 'auto');
        }

        async function bgSampleBehind() {
            if (bgBehindBusy || document.hidden) return;
            bgBehindBusy = true;
            try {
                let color = null;
                const liveVideo = document.getElementById('bg-live');
                if (bgLiveStream && liveVideo && liveVideo.videoWidth > 0) {
                    // The live stream already shows exactly what's behind the
                    // window (the window excludes itself from the capture), so
                    // sample its pixels directly — the main process's
                    // desktopCapturer thumbnails come back empty while this
                    // WebRTC capture is running anyway.
                    color = bgSampleLiveColor(liveVideo);
                } else if (window.electronAPI?.backgroundSampleBehind) {
                    const raw = await window.electronAPI.backgroundSampleBehind();
                    if (raw) color = bgAccentify(raw);
                }
                // Settings may have changed while the capture was in flight.
                if (color && bgBehindSamplingWanted(getBgSettings())) {
                    // Small threshold so capture noise doesn't repaint the
                    // theme every tick when nothing really changed.
                    if (bgColorDelta(color, bgBehindColor) > 9) {
                        bgBehindColor = color;
                        bgApplyTheme(getBgSettings());
                    }
                }
            } catch (e) { /* best-effort — the static Auto color stays */ }
            bgBehindBusy = false;
        }

        // Crops the live screen stream to the window's own area (in stream
        // pixels) before sampling, so the color tracks what's directly behind
        // the app rather than the whole screen.
        function bgSampleLiveColor(video) {
            const d = bgLiveDisplay;
            if (!d || !bgWinPos) return bgSampleMediaColor(video);
            const fx = video.videoWidth / d.width;
            const fy = video.videoHeight / d.height;
            const sx = Math.max(0, (bgWinPos.x - d.x) * fx);
            const sy = Math.max(0, (bgWinPos.y - d.y) * fy);
            const sw = Math.min(video.videoWidth - sx, window.innerWidth * fx);
            const sh = Math.min(video.videoHeight - sy, window.innerHeight * fy);
            if (sw < 4 || sh < 4) return bgSampleMediaColor(video);
            return bgSampleMediaColor(video, { sx, sy, sw, sh });
        }

        function bgColorDelta(a, b) {
            if (!b) return Infinity;
            const ra = bgHexToRgb(a), rb = bgHexToRgb(b);
            if (!ra || !rb) return Infinity;
            return Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2]);
        }

        function bgBehindSyncLoop(s) {
            const want = bgBehindSamplingWanted(s);
            if (want && !bgBehindTimer) {
                bgBehindTimer = setInterval(bgSampleBehind, 4000);
                bgSampleBehind();
            } else if (!want && bgBehindTimer) {
                clearInterval(bgBehindTimer);
                bgBehindTimer = null;
                bgBehindColor = null;
            }
        }

        function bgResolveAccent(s) {
            if (s.theme === 'custom') return bgAccentify(s.customAccent);
            const themed = BG_THEMES.find(t => t.id === s.theme && t.accent);
            if (themed) return themed.accent;
            // Auto — follow the background.
            if (s.preset === 'custom' && s.customFile) {
                return bgMediaAccentCache[s.customFile] || '#ffffff';
            }
            if (s.preset === 'diy') return bgAccentify(s.diyColors?.[0] || '#ffffff');
            // Transparent: the live sample of what's behind the window.
            if (s.preset === 'clear' && bgBehindColor) return bgBehindColor;
            return BG_PRESETS.find(p => p.id === s.preset)?.accent || '#ffffff';
        }

        function bgApplyTheme(s) {
            // Start/stop the behind-window sampler to match the settings —
            // every theme/preset change funnels through here.
            bgBehindSyncLoop(s);
            const accent = bgResolveAccent(s);
            const rgb = bgHexToRgb(accent) || [255, 255, 255];
            bgAccentRgbStr = `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
            const docStyle = document.documentElement.style;
            docStyle.setProperty('--accent', bgAccentRgbStr);
            docStyle.setProperty('--accent-solid', accent);
            // The voice overlay is a separate window and cannot see this CSS
            // variable, so it is handed the accent with its vocabulary. Without
            // this nudge the overlay kept whatever colour it had at startup and
            // changing the theme appeared to do nothing to it.
            if (typeof pushVoiceVocabulary === 'function') pushVoiceVocabulary(true);
            // Quick Launch tiles: a colored theme deep-tints the tile face behind
            // each icon (accent at ~16% over black) and its border. Pure white
            // (unthemed) keeps the app's original neutral tile exactly.
            if (accent.toLowerCase() === '#ffffff') {
                docStyle.setProperty('--tile-bg', '#0a0a0a');
                docStyle.setProperty('--tile-border', 'rgba(255, 255, 255, 0.1)');
            } else {
                const shade = rgb.map(v => Math.round(v * 0.16));
                docStyle.setProperty('--tile-bg', `rgb(${shade[0]}, ${shade[1]}, ${shade[2]})`);
                docStyle.setProperty('--tile-border', `rgba(${bgAccentRgbStr}, 0.22)`);
            }

            // ── Text color ──
            // The app's grey text scale is exactly white at 83/64/45/32% alpha,
            // so any chosen text color regenerates the full hierarchy from those
            // same alphas — secondary text stays proportionally dimmer.
            let text = null;
            if (s.textTheme === 'auto') {
                text = accent.toLowerCase() === '#ffffff' ? null : bgTextify(accent);
            } else if (s.textTheme === 'custom') {
                text = bgTextify(s.customText);
            } else {
                const def = BG_TEXT_THEMES.find(t => t.id === s.textTheme);
                text = def && def.color && def.id !== 'white' ? def.color : null;
            }
            const TEXT_VARS = ['--text-main', '--text-soft', '--text-mid', '--text-dim', '--text-faint'];
            if (!text) {
                // Default white palette lives in the CSS fallbacks.
                for (const v of TEXT_VARS) docStyle.removeProperty(v);
            } else {
                const t = bgHexToRgb(text) || [255, 255, 255];
                const shadeOf = (a) => `rgba(${t[0]}, ${t[1]}, ${t[2]}, ${a})`;
                docStyle.setProperty('--text-main', text);
                docStyle.setProperty('--text-soft', shadeOf(0.83));
                docStyle.setProperty('--text-mid', shadeOf(0.64));
                docStyle.setProperty('--text-dim', shadeOf(0.45));
                docStyle.setProperty('--text-faint', shadeOf(0.32));
            }
        }

        // ══════════════════════════════════════════════════════════════
        // Frosted transparent (effects over the Transparent preset)
        // ══════════════════════════════════════════════════════════════
        // CSS filters can't touch the live desktop behind a transparent window
        // (and Windows 10 has no acrylic API), so when an effect is active on
        // the Transparent preset, the desktop WALLPAPER is shown screen-aligned
        // behind the window and the filters frost that instead. With no effects
        // the layer is hidden and the window stays truly see-through.

        let bgDesktopInfo = null;   // { wallpaper, display: {x,y,width,height} }
        let bgWinPos = null;        // window top-left in screen coords, kept live
        let bgWinPosStamp = 0;      // when bgWinPos last came from the live move stream
        let bgBackdropDisplayId = null;  // display the backdrop layers are aligned to

        // ── Live capture (real blur, rounded corners) ──
        // The compositor-level blur tried first (SetWindowCompositionAttribute)
        // paints across the window's square bounds and can't be clipped to the
        // card's rounded corners. So instead the main process supplies a LIVE
        // video stream of the screen — with this window excluded from the
        // capture, so the stream shows what's BEHIND it — and that video is
        // placed screen-aligned inside #bg-root, where the normal blur /
        // brightness / saturation filters and the card's 32px rounded clipping
        // apply to it like any other background. The Blur slider therefore
        // controls real blur strength on Transparent too. While the stream is
        // active the app is invisible to screenshots/recordings (that's the
        // exclusion doing its job). Any failure falls back to wallpaper frost.
        let bgLiveAvailable = null;   // null = untried, false = capture failed
        let bgLiveStream = null;
        let bgLiveSourceId = null;
        let bgLiveDisplay = null;     // display bounds for screen-alignment
        let bgLiveStarting = false;
        let bgLiveIpcOn = false;      // main has capture-exclusion enabled
        // Monotonic request number shared by every start/stop. It orders the IPC
        // in main (a stale stop can never undo a newer start) and lets an async
        // start abort when something superseded it mid-flight.
        let bgLiveGen = 0;

        // The page flips hidden/visible constantly in normal use — every alt-tab
        // that fully covers the window marks it hidden. Tearing the capture down
        // and rebuilding it on each flip is what produced the recursive-mirror
        // flashes: in the gap between lifting the capture exclusion and the
        // stream actually ending, the window captures ITSELF. So only a real
        // absence (tray / minimise) stops it; a quick alt-tab round-trip keeps
        // the stream alive and costs nothing to come back to.
        const BG_LIVE_HIDE_GRACE_MS = 5000;
        let bgDeepHidden = false;
        let bgHideGraceTimer = null;

        function bgLiveWanted(s) {
            if (s.preset !== 'clear' || bgLiveAvailable === false) return false;
            if (!window.electronAPI?.backgroundLiveCapture) return false;
            return s.blur > 0 || s.saturation !== 100 || s.brightness > 100;
        }

        async function bgLiveEnsure(recheck) {
            const video = document.getElementById('bg-live');
            if (!video || bgLiveStarting) return;
            // With a running stream, applying settings only needs a replay —
            // the IPC re-check is reserved for drags onto another display.
            if (bgLiveStream && !recheck) {
                video.classList.add('bg-active');
                video.play().catch(() => {});
                return;
            }
            bgLiveStarting = true;
            const startedAt = Date.now();
            const gen = ++bgLiveGen;
            try {
                const info = await window.electronAPI.backgroundLiveCapture(true, gen);
                // A sourceId means the main process turned the capture
                // exclusion on — remember that so bgLiveStop() can lift it
                // even if the stream itself fails to start below.
                if (info?.sourceId) bgLiveIpcOn = true;
                // Superseded while the IPC was in flight (a stop, or a newer
                // start): whoever bumped the generation owns the stream now.
                // Carrying on would race them into showing a stream the other
                // path is about to tear the exclusion out from under.
                if (gen !== bgLiveGen) return;
                // Settings may have changed while the IPC was in flight.
                if (!bgLiveWanted(getBgSettings()) || bgDeepHidden) { bgLiveStop(); return; }
                if (!info?.sourceId) throw new Error('no capture source');
                // A drag easily outruns this IPC round-trip, so the live move
                // stream wins: only adopt the snapshot position if nothing
                // newer arrived while the call was in flight, or the backdrop
                // snaps back to where the window was when it started.
                if (bgWinPosStamp < startedAt) bgWinPos = info.window;
                bgLiveDisplay = info.display;
                if (info.displayId) bgBackdropDisplayId = info.displayId;
                if (!bgLiveStream || bgLiveSourceId !== info.sourceId) {
                    const old = bgLiveStream;
                    // Land the new stream in a local until it's committed:
                    // assigning bgLiveStream before the re-check below would
                    // hand a stop (or a newer start) a stream it doesn't own.
                    const fresh = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: {
                            mandatory: {
                                chromeMediaSource: 'desktop',
                                chromeMediaSourceId: info.sourceId,
                                maxWidth: 1920,
                                maxHeight: 1200,
                                maxFrameRate: 30
                            }
                        }
                    });
                    // getUserMedia is the second await — re-check, or a stop
                    // that landed during it would be undone by the reveal below
                    // while main has already lifted the capture exclusion.
                    // Whoever superseded us owns bgLiveStream now; just drop
                    // the stream we opened and leave their state alone.
                    if (gen !== bgLiveGen) {
                        fresh.getTracks().forEach(t => t.stop());
                        return;
                    }
                    bgLiveStream = fresh;
                    bgLiveSourceId = info.sourceId;
                    if (old) old.getTracks().forEach(t => t.stop());
                    video.srcObject = bgLiveStream;
                    const track = bgLiveStream.getVideoTracks()[0];
                    // Display topology changes can end the track — re-evaluate
                    // so the stream restarts (or frost takes over).
                    if (track) track.addEventListener('ended', () => {
                        bgLiveSourceId = null;
                        applyBackground();
                    });
                }
                bgMeasureBackdropOrigin();
                bgPositionWallpaper();
                video.classList.add('bg-active');
                video.play().catch(() => {});
                bgLiveAvailable = true;
                // Parallax must release its background drift while the backdrop
                // is live (see parallaxApply) — refresh it in case the mouse
                // hasn't moved since.
                if (typeof parallaxKick === 'function') parallaxKick();
            } catch (e) {
                // Lands in the main log via the renderer console hook.
                console.error('Live background capture unavailable, falling back to wallpaper frost:', e.message || e);
                bgLiveStop();
                if (bgLiveAvailable !== false) {
                    bgLiveAvailable = false;
                    // Route the effects to the wallpaper frost instead.
                    applyBackground();
                }
            } finally {
                bgLiveStarting = false;
            }
        }

        function bgLiveStop() {
            const video = document.getElementById('bg-live');
            if (video) {
                video.classList.remove('bg-active');
                if (video.srcObject) video.srcObject = null;
            }
            if (bgLiveStream) {
                bgLiveStream.getTracks().forEach(t => t.stop());
                bgLiveStream = null;
                bgLiveSourceId = null;
            }
            // Lift the screenshot/recording exclusion again — including when
            // the stream never got past the IPC step, so a failed start can't
            // leave the app permanently hidden from captures. The generation
            // goes up first: it both cancels any start still in flight and
            // stops this disable from being applied out of order in main.
            if (bgLiveIpcOn && window.electronAPI?.backgroundLiveCapture) {
                bgLiveIpcOn = false;
                window.electronAPI.backgroundLiveCapture(false, ++bgLiveGen).catch(() => {});
            } else {
                bgLiveGen += 1;
            }
        }

        function bgFrostWanted(s) {
            if (s.preset !== 'clear') return false;
            // The live stream shows the real view — the wallpaper stand-in
            // must stay hidden or it would cover it.
            if (bgLiveWanted(s)) return false;
            return s.blur > 0 || s.saturation !== 100 || s.brightness > 100;
        }

        // Where #bg-backdrop's own origin sits inside the window, in CSS px.
        // This used to be assumed to be exactly -96 (the bleed in
        // backgrounds.css), but that assumption is wrong in several ways at
        // once: `inset: -96px` is measured from #main-window's PADDING box, so
        // the card's 1px border shifts it (at dpr 1.5 Chromium snaps that
        // border to 0.667px, putting the real origin at -95.333), and it also
        // assumes the card sits flush at the window's top-left. Measure it
        // instead — then the backdrop stays screen-locked no matter what the
        // page layout does.
        let bgBackdropOrigin = { x: -96, y: -96 };

        function bgMeasureBackdropOrigin() {
            const host = document.getElementById('bg-backdrop');
            if (!host) return;
            // Safe to use a bounding rect here: parallax always clears
            // #bg-root's transform while a backdrop layer is active
            // (parallaxApply), so no ancestor transform can skew this. Only
            // called on activation / resize, never per drag step — it forces
            // a layout flush.
            const r = host.getBoundingClientRect();
            bgBackdropOrigin = { x: r.left, y: r.top };
        }

        function bgPositionWallpaper() {
            if (!bgWinPos) return;
            // Convert screen coords into layer coords: subtracting the window's
            // screen position gives viewport coords, and subtracting the
            // backdrop's own viewport origin gives the local offset.
            //
            // The offset is written as a TRANSFORM, never left/top: these layers
            // live under #bg-root's blur filter, where a left/top write dirties
            // layout for the entire filtered subtree — i.e. a full re-layout and
            // re-blur of a screen-sized video on every step of a window drag.
            // The size only changes when the display does, so it's only written
            // when it actually differs (see .bg-wallpaper in backgrounds.css).
            const place = (el, d) => {
                if (!el || !d) return;
                const w = `${d.width}px`;
                const h = `${d.height}px`;
                if (el.style.width !== w) el.style.width = w;
                if (el.style.height !== h) el.style.height = h;
                el.style.transform = `translate3d(${d.x - bgWinPos.x - bgBackdropOrigin.x}px, ` +
                    `${d.y - bgWinPos.y - bgBackdropOrigin.y}px, 0)`;
            };
            place(document.getElementById('bg-wallpaper'), bgDesktopInfo?.display);
            place(document.getElementById('bg-live'), bgLiveDisplay);
        }

        async function bgUpdateFrost() {
            const wp = document.getElementById('bg-wallpaper');
            if (!wp) return;
            if (!window.electronAPI?.backgroundDesktopInfo) {
                wp.classList.remove('bg-active');
                return;
            }
            const startedAt = Date.now();
            try {
                bgDesktopInfo = await window.electronAPI.backgroundDesktopInfo();
            } catch (e) {
                bgDesktopInfo = null;
            }
            // Settings may have changed while the IPC round-trip was in flight.
            if (!bgDesktopInfo?.wallpaper || !bgFrostWanted(getBgSettings())) {
                wp.classList.remove('bg-active');
                return;
            }
            // Same as bgLiveEnsure: a drag in progress outruns the round-trip,
            // so the live move stream wins over this snapshot.
            if (bgWinPosStamp < startedAt) bgWinPos = bgDesktopInfo.window;
            if (bgDesktopInfo.displayId) bgBackdropDisplayId = bgDesktopInfo.displayId;
            const url = iconFileUrl(bgDesktopInfo.wallpaper);
            if (wp.getAttribute('src') !== url) wp.src = url;
            bgMeasureBackdropOrigin();
            bgPositionWallpaper();
            wp.classList.add('bg-active');
            // Same parallax release as the live backdrop (see parallaxApply).
            if (typeof parallaxKick === 'function') parallaxKick();
        }

        // ══════════════════════════════════════════════════════════════
        // Applying the saved background
        // ══════════════════════════════════════════════════════════════

        function applyBackground() {
            const s = getBgSettings();
            const root = document.getElementById('bg-root');
            const image = document.getElementById('bg-image');
            const video = document.getElementById('bg-video');
            if (!root || !image || !video) return;

            bgSpeedFactor = s.speed;

            const isCustom = s.preset === 'custom' && s.customFile;
            const presetDef = BG_PRESETS.find(p => p.id === s.preset);
            root.dataset.preset = isCustom ? 'custom' : (presetDef ? s.preset : 'mono');
            // Blob layers only exist for presets that define blob colors; flat flag
            // so the CSS doesn't need a per-preset display rule.
            const hasBlobs = ['aurora', 'prism', 'nebula', 'sunset', 'ocean'].includes(root.dataset.preset)
                || (root.dataset.preset === 'diy' && s.diyBlobs);
            root.dataset.blobs = hasBlobs ? '1' : '0';
            root.style.setProperty('--bg-speed', String(s.speed));

            // ── "My Scene" (user-built gradient) ──
            // Its colors are dynamic, so they're set as inline variables — which
            // outrank the attribute-selector presets in backgrounds.css — and must
            // be cleared again when any other preset is active.
            const DIY_VARS = ['--bg-scene-bg', '--bg-pool-a', '--bg-pool-b', '--blob-a', '--blob-b', '--blob-c'];
            if (root.dataset.preset === 'diy') {
                const [c1, c2, c3] = [0, 1, 2].map(i => s.diyColors?.[i] || BG_DEFAULTS.diyColors[i]);
                root.style.setProperty('--bg-scene-bg',
                    `radial-gradient(ellipse 85% 65% at 50% 0%, ${bgRgba(c1, 0.12)}, transparent 62%),` +
                    `radial-gradient(ellipse 55% 45% at 80% 100%, ${bgRgba(c2, 0.11)}, transparent 55%),` +
                    '#060608');
                root.style.setProperty('--bg-pool-a', bgRgba(c1, 0.12));
                root.style.setProperty('--bg-pool-b', bgRgba(c2, 0.11));
                root.style.setProperty('--blob-a', bgRgba(c1, 0.13));
                root.style.setProperty('--blob-b', bgRgba(c2, 0.12));
                root.style.setProperty('--blob-c', bgRgba(c3, 0.10));
            } else {
                for (const v of DIY_VARS) root.style.removeProperty(v);
            }

            // ── Custom media ──
            const fit = ['cover', 'contain', 'fill'].includes(s.mediaFit) ? s.mediaFit : 'cover';
            image.style.objectFit = fit;
            video.style.objectFit = fit;
            if (isCustom && s.customType === 'image') {
                const url = bgMediaUrl(s.customFile);
                if (image.getAttribute('src') !== url) image.src = url;
                image.classList.add('bg-active');
            } else {
                image.classList.remove('bg-active');
                if (image.getAttribute('src')) image.removeAttribute('src');
            }

            if (isCustom && s.customType === 'video') {
                const url = bgMediaUrl(s.customFile);
                if (video.getAttribute('src') !== url) {
                    video.src = url;
                    video.load();
                }
                video.classList.add('bg-active');
                if (!document.hidden) video.play().catch(() => {});
            } else {
                video.classList.remove('bg-active');
                if (video.getAttribute('src')) {
                    // Actually release the decoder/file handle, not just hide it.
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
            }

            // ── Particle scene ──
            // Respect the OS "reduce motion" setting the same way main.css does for
            // the decorative CSS animations — the preset's gradients still show,
            // just without the moving particles.
            const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const wantCanvas = !isCustom && !reduceMotion && presetDef?.canvas ? presetDef.canvas : null;
            if (wantCanvas !== bgCanvasMode) {
                if (wantCanvas) bgCanvasStart(wantCanvas);
                else bgCanvasStop();
            }

            // ── Transparent preset: live capture / frosted wallpaper / veil ──
            const scene = root.querySelector('.bg-scene');
            const wallpaperEl = document.getElementById('bg-wallpaper');
            if (root.dataset.preset === 'clear') {
                // While genuinely away (tray/minimised for a while), everything
                // shuts off — the live capture especially must not keep burning
                // CPU. A momentary hide (alt-tab) does NOT count: see
                // BG_LIVE_HIDE_GRACE_MS and the visibilitychange handler.
                const live = bgLiveWanted(s) && !bgDeepHidden;
                const frost = !live && bgFrostWanted(s);
                // Blur & co. need the live stream or the wallpaper stand-in,
                // but plain DIMMING works on the real see-through view: a
                // translucent black veil layers over the live desktop where a
                // CSS filter can't reach it.
                if (scene) {
                    scene.style.background = (!live && !frost && s.brightness < 100)
                        ? `rgba(0, 0, 0, ${((100 - s.brightness) / 100).toFixed(2)})`
                        : '';
                }
                if (live) bgLiveEnsure(); else bgLiveStop();
                if (frost) bgUpdateFrost();
                else wallpaperEl?.classList.remove('bg-active');
            } else {
                if (scene) scene.style.background = '';
                wallpaperEl?.classList.remove('bg-active');
                bgLiveStop();
            }

            // ── Effects ──
            const filters = [];
            if (s.blur > 0) filters.push(`blur(${s.blur}px)`);
            if (s.brightness !== 100) filters.push(`brightness(${s.brightness / 100})`);
            if (s.saturation !== 100) filters.push(`saturate(${s.saturation / 100})`);
            root.style.filter = filters.join(' ');

            document.getElementById('bg-vignette')?.classList.toggle('bg-active', !!s.vignette);
            document.getElementById('bg-noise')?.classList.toggle('bg-active', !!s.grain);
            document.querySelector('.grid-overlay')?.classList.toggle('bg-layer-off', !s.grid);
            document.querySelector('.scanline')?.classList.toggle('bg-layer-off', !s.scanlines);

            document.documentElement.style.setProperty('--glass-alpha', (s.glass / 100).toFixed(2));

            bgApplyTheme(s);
        }

        // A missing/corrupt custom file (deleted from disk, unsupported codec) must
        // never leave a black hole — fall back to the default scene and say so.
        // `kind` gates it to the element that's actually showing the custom media:
        // tearing down the OTHER element (removing its src) can surface a stray
        // error event that must not knock out the background the user just picked.
        function bgHandleMediaError(kind) {
            const s = getBgSettings();
            if (s.preset !== 'custom' || s.customType !== kind) return;
            setBgSettings({ preset: 'mono', customFile: null, customType: null });
            applyBackground();
            showToast('Background file could not be loaded — reverted to default', true);
        }

        // ══════════════════════════════════════════════════════════════
        // Settings UI (gallery + effect controls)
        // ══════════════════════════════════════════════════════════════

        function bgPaintSlider(slider) {
            if (!slider) return;
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            const val = parseFloat(slider.value);
            const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
            slider.style.background = `linear-gradient(to right, var(--accent-solid, #fff) ${pct.toFixed(2)}%, rgba(255,255,255,0.15) ${pct.toFixed(2)}%)`;
        }

        // Pushes saved settings into the Settings controls (sliders, value labels,
        // toggles). Used on open and after reset/import.
        function syncBgControls() {
            const s = getBgSettings();
            const set = (id, value, label) => {
                const el = document.getElementById(id);
                if (el) { el.value = value; bgPaintSlider(el); }
                const valEl = document.getElementById(`${id}-val`);
                if (valEl) valEl.textContent = label;
            };
            set('bg-blur', s.blur, `${s.blur}px`);
            set('bg-brightness', s.brightness, `${s.brightness}%`);
            set('bg-saturation', s.saturation, `${s.saturation}%`);
            set('bg-speed', s.speed, `${s.speed.toFixed(2).replace(/0$/, '')}×`);
            set('bg-glass', s.glass, `${s.glass}%`);
            const check = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };
            check('bg-toggle-grain', s.grain);
            check('bg-toggle-vignette', s.vignette);
            check('bg-toggle-grid', s.grid);
            check('bg-toggle-scanlines', s.scanlines);

            // "My Scene" builder — only shown while that scene is selected.
            document.getElementById('bg-diy-options')?.classList.toggle('hidden', s.preset !== 'diy');
            ['bg-diy-c1', 'bg-diy-c2', 'bg-diy-c3'].forEach((id, i) => {
                const el = document.getElementById(id);
                if (el) el.value = s.diyColors?.[i] || BG_DEFAULTS.diyColors[i];
            });
            check('bg-diy-blobs', s.diyBlobs);

            // Media fit — only relevant while the user's own media is showing.
            document.getElementById('bg-media-options')?.classList.toggle('hidden', s.preset !== 'custom');
            const fitSel = document.getElementById('bg-media-fit');
            if (fitSel) fitSel.value = ['cover', 'contain', 'fill'].includes(s.mediaFit) ? s.mediaFit : 'cover';
        }

        function saveBgControls() {
            const num = (id, fallback) => {
                const el = document.getElementById(id);
                const v = el ? parseFloat(el.value) : NaN;
                return isNaN(v) ? fallback : v;
            };
            const checked = (id) => !!document.getElementById(id)?.checked;
            setBgSettings({
                blur: num('bg-blur', BG_DEFAULTS.blur),
                brightness: num('bg-brightness', BG_DEFAULTS.brightness),
                saturation: num('bg-saturation', BG_DEFAULTS.saturation),
                speed: num('bg-speed', BG_DEFAULTS.speed),
                glass: num('bg-glass', BG_DEFAULTS.glass),
                grain: checked('bg-toggle-grain'),
                vignette: checked('bg-toggle-vignette'),
                grid: checked('bg-toggle-grid'),
                scanlines: checked('bg-toggle-scanlines')
            });
            syncBgControls();
            applyBackground();
            scheduleSettingsSave();
        }

        function bgSelectPreset(id) {
            if (!BG_PRESETS.some(p => p.id === id)) return;
            setBgSettings({ preset: id, customFile: null, customType: null });
            applyBackground();
            renderBackgroundSettings();
            scheduleSettingsSave();
        }

        function bgSelectTheme(id) {
            if (!BG_THEMES.some(t => t.id === id)) return;
            const s = setBgSettings({ theme: id });
            bgApplyTheme(s);
            renderBgThemeRow(s);
            scheduleSettingsSave();
        }

        function bgSelectTextTheme(id) {
            if (!BG_TEXT_THEMES.some(t => t.id === id)) return;
            const s = setBgSettings({ textTheme: id });
            bgApplyTheme(s);
            renderBgTextRow(s);
            scheduleSettingsSave();
        }

        // Same in-place update as the accent picker — fires per drag tick.
        function bgCustomTextInput(value) {
            const s = setBgSettings({ textTheme: 'custom', customText: value });
            bgApplyTheme(s);
            const row = document.getElementById('bg-text-row');
            if (row) {
                row.querySelectorAll('.bg-swatch').forEach(el => el.classList.remove('selected'));
                const custom = row.querySelector('.bg-swatch-custom');
                if (custom) {
                    custom.classList.add('selected');
                    custom.style.background = value;
                }
            }
            scheduleSettingsSave();
        }

        // Fires continuously while the color picker is dragged — update in place
        // instead of re-rendering the row, or the open picker would be destroyed.
        function bgCustomAccentInput(value) {
            const s = setBgSettings({ theme: 'custom', customAccent: value });
            bgApplyTheme(s);
            const row = document.getElementById('bg-theme-row');
            if (row) {
                row.querySelectorAll('.bg-swatch').forEach(el => el.classList.remove('selected'));
                const custom = row.querySelector('.bg-swatch-custom');
                if (custom) {
                    custom.classList.add('selected');
                    custom.style.background = value;
                }
            }
            scheduleSettingsSave();
        }

        // "My Scene" builder — also fires continuously while dragging a color
        // picker, so it updates the live background and the gallery preview card
        // in place rather than rebuilding the gallery mid-drag.
        function saveBgDiy() {
            const colors = ['bg-diy-c1', 'bg-diy-c2', 'bg-diy-c3'].map((id, i) => {
                const el = document.getElementById(id);
                return bgHexToRgb(el?.value) ? el.value : BG_DEFAULTS.diyColors[i];
            });
            const s = setBgSettings({
                diyColors: colors,
                diyBlobs: !!document.getElementById('bg-diy-blobs')?.checked
            });
            applyBackground();
            const preview = document.getElementById('bg-diy-preview');
            if (preview) preview.style.cssText = bgDiyPreviewCss(s);
            if (s.theme === 'auto') renderBgThemeRow(s);
            scheduleSettingsSave();
        }

        function saveBgMediaFit() {
            const sel = document.getElementById('bg-media-fit');
            setBgSettings({ mediaFit: ['cover', 'contain', 'fill'].includes(sel?.value) ? sel.value : 'cover' });
            applyBackground();
            scheduleSettingsSave();
        }

        function bgSelectCustom(file, type) {
            setBgSettings({ preset: 'custom', customFile: file, customType: type });
            applyBackground();
            renderBackgroundSettings();
            scheduleSettingsSave();
        }

        async function bgAddCustom() {
            if (!window.electronAPI?.backgroundSelect) {
                showToast('Background picker unavailable', true);
                return;
            }
            const result = await window.electronAPI.backgroundSelect();
            if (!result) return;                       // dialog cancelled
            if (result.error) {
                showToast(result.error, true);
                return;
            }
            bgSelectCustom(result.file, result.type);   // re-renders the gallery too
            showToast('Background added');
        }

        async function bgDeleteCustom(file, event) {
            // The delete button sits inside the selectable card — don't let the
            // click also select (or re-select) the background being removed.
            if (event) event.stopPropagation();
            // If it's the one currently showing, switch away FIRST so the video
            // element releases its file handle — Windows won't delete an open file.
            const s = getBgSettings();
            if (s.preset === 'custom' && s.customFile === file) {
                setBgSettings({ preset: 'mono', customFile: null, customType: null });
                applyBackground();
            }
            const result = await window.electronAPI?.backgroundDelete?.(file);
            renderBackgroundSettings();
            scheduleSettingsSave();
            if (result?.success) showToast('Background removed');
            else showToast('Could not remove the file — it may be in use', true);
        }

        function bgResetAll() {
            localStorage.setItem(BG_SETTINGS_KEY, JSON.stringify(BG_DEFAULTS));
            applyBackground();
            renderBackgroundSettings();
            scheduleSettingsSave();
            showToast('Background reset to default');
        }

        async function renderBackgroundSettings() {
            const gallery = document.getElementById('bg-preset-gallery');
            if (!gallery) return;
            const s = getBgSettings();

            let customs = [];
            if (window.electronAPI?.backgroundList) {
                try { customs = await window.electronAPI.backgroundList(); } catch (e) { customs = []; }
            }

            const presetCards = BG_PRESETS.map(p => {
                // "My Scene" previews the user's current colors, so its card is
                // painted inline (and repainted live by saveBgDiy) instead of
                // using a static data-preview gradient from the stylesheet.
                const preview = p.id === 'diy'
                    ? `<div class="bg-card-preview" id="bg-diy-preview" style="${esc(bgDiyPreviewCss(s))}"></div>`
                    : `<div class="bg-card-preview" data-preview="${p.id}"></div>`;
                return `
                <div class="bg-card${s.preset === p.id ? ' selected' : ''}" onclick="bgSelectPreset(${jsAttr(p.id)})" title="${esc(p.name)}">
                    ${preview}
                    <span class="bg-card-name">${esc(p.name)}</span>
                    <i class="fas fa-check bg-card-check"></i>
                </div>`;
            });

            const customCards = customs.map(c => {
                const selected = s.preset === 'custom' && s.customFile === c.file;
                const url = esc(bgMediaUrl(c.file));
                const media = c.type === 'video'
                    ? `<video class="bg-card-media" src="${url}" preload="metadata" muted></video>`
                    : `<img class="bg-card-media" src="${url}" alt="">`;
                // Escape quotes for the inline handler args (filenames can contain ').
                const fileArg = esc(c.file).replace(/&#39;/g, "\\'");
                return `
                <div class="bg-card${selected ? ' selected' : ''}" onclick="bgSelectCustom(${jsAttr(fileArg)}, ${jsAttr(c.type)})" title="${esc(c.file)}">
                    ${media}
                    <span class="bg-card-badge">${c.type === 'video' ? 'video' : 'image'}</span>
                    <span class="bg-card-name">${esc(c.file.replace(/\.[^.]+$/, ''))}</span>
                    <i class="fas fa-check bg-card-check"></i>
                    <button type="button" class="bg-card-delete no-drag" onclick="bgDeleteCustom(${jsAttr(fileArg)}, event)" title="Remove">✕</button>
                </div>`;
            });

            const addCard = `
                <div class="bg-card bg-card-add" onclick="bgAddCustom()">
                    <i class="fas fa-plus"></i>
                    <span>Add media</span>
                </div>`;

            gallery.innerHTML = presetCards.join('') + customCards.join('') + addCard;
            renderBgThemeRow(s);
            renderBgTextRow(s);
            syncBgControls();
        }

        function bgDiyPreviewCss(s) {
            const [c1, c2, c3] = [0, 1, 2].map(i => s.diyColors?.[i] || BG_DEFAULTS.diyColors[i]);
            return 'background:' +
                `radial-gradient(ellipse 70% 80% at 18% 15%, ${bgRgba(c1, 0.55)}, transparent 62%),` +
                `radial-gradient(ellipse 65% 70% at 85% 30%, ${bgRgba(c2, 0.45)}, transparent 60%),` +
                `radial-gradient(ellipse 75% 65% at 50% 100%, ${bgRgba(c3, 0.40)}, transparent 60%),` +
                '#070709';
        }

        function renderBgThemeRow(s) {
            const row = document.getElementById('bg-theme-row');
            if (!row) return;
            const swatches = BG_THEMES.map(t => {
                const sel = s.theme === t.id ? ' selected' : '';
                if (t.id === 'auto') {
                    return `<span class="bg-swatch bg-swatch-auto${sel}" onclick="bgSelectTheme('auto')" title="${esc(t.name)}"><i class="fas fa-wand-magic-sparkles"></i></span>`;
                }
                return `<span class="bg-swatch${sel}" style="background:${t.accent}" onclick="bgSelectTheme(${jsAttr(t.id)})" title="${esc(t.name)}"></span>`;
            }).join('');
            const customSel = s.theme === 'custom' ? ' selected' : '';
            const custom = `<span class="bg-swatch bg-swatch-custom${customSel}" style="background:${esc(s.customAccent)}" title="Custom color — click to pick">` +
                `<input type="color" value="${esc(s.customAccent)}" oninput="bgCustomAccentInput(this.value)">` +
                `<i class="fas fa-eye-dropper"></i></span>`;
            row.innerHTML = swatches + custom;
        }

        function renderBgTextRow(s) {
            const row = document.getElementById('bg-text-row');
            if (!row) return;
            const swatches = BG_TEXT_THEMES.map(t => {
                const sel = s.textTheme === t.id ? ' selected' : '';
                if (t.id === 'auto') {
                    return `<span class="bg-swatch bg-swatch-auto${sel}" onclick="bgSelectTextTheme('auto')" title="${esc(t.name)}"><i class="fas fa-font"></i></span>`;
                }
                return `<span class="bg-swatch${sel}" style="background:${t.color}" onclick="bgSelectTextTheme(${jsAttr(t.id)})" title="${esc(t.name)}"></span>`;
            }).join('');
            const customSel = s.textTheme === 'custom' ? ' selected' : '';
            const custom = `<span class="bg-swatch bg-swatch-custom${customSel}" style="background:${esc(s.customText)}" title="Custom text color — click to pick">` +
                `<input type="color" value="${esc(s.customText)}" oninput="bgCustomTextInput(this.value)">` +
                `<i class="fas fa-eye-dropper"></i></span>`;
            row.innerHTML = swatches + custom;
        }

        // Apply the saved background immediately at script load — the layer stack
        // is already in the DOM (scripts sit at the end of <body>), so the custom
        // scene appears on first paint with no flash of the default.
        (function initBackground() {
            const image = document.getElementById('bg-image');
            const video = document.getElementById('bg-video');
            if (image) image.addEventListener('error', () => bgHandleMediaError('image'));
            if (video) video.addEventListener('error', () => bgHandleMediaError('video'));
            // Once the media has pixels, sample its dominant color for the Auto theme.
            if (image) image.addEventListener('load', () => bgOnMediaReady(image));
            if (video) video.addEventListener('loadeddata', () => bgOnMediaReady(video));
            // Frosted-transparent wallpaper: track window drags so the wallpaper
            // stays pixel-aligned with the real desktop, and never let a failed
            // wallpaper load leave a broken-image box over the transparency.
            const wallpaper = document.getElementById('bg-wallpaper');
            if (wallpaper) wallpaper.addEventListener('error', () => wallpaper.classList.remove('bg-active'));
            // Resolution switches (games!), monitor changes, and scale changes
            // invalidate the backdrop's screen alignment — re-sync it. Debounced
            // because Windows fires a burst of metrics events per mode change.
            if (window.electronAPI?.onDisplayChanged) {
                let bgDisplayChangeTimer = null;
                window.electronAPI.onDisplayChanged(() => {
                    clearTimeout(bgDisplayChangeTimer);
                    bgDisplayChangeTimer = setTimeout(() => {
                        if (bgLiveStream) bgLiveEnsure(true);
                        else applyBackground();   // re-evaluates frost/live for the new display
                    }, 600);
                });
            }
            // Anything that can move the card inside the window (a resize, a
            // Ctrl +/- zoom step — which rescales every CSS px) invalidates the
            // measured backdrop origin. Re-measure and re-place, or the
            // backdrop sits offset from the desktop behind it.
            window.addEventListener('resize', () => {
                bgMeasureBackdropOrigin();
                bgPositionWallpaper();
            });

            if (window.electronAPI?.onWindowMoved) {
                let bgMoveSampleTimer = null;
                let bgMoveDisplayTimer = null;
                let bgMoveRaf = null;
                let bgMovePending = null;

                // Main already throttles the move stream to ~60 Hz; folding it
                // into a single rAF here guarantees at most ONE backdrop re-place
                // per painted frame even if a burst slips through, and lands that
                // write in the frame the compositor is about to draw instead of
                // somewhere between frames (which is what made the backdrop tear
                // and swim while the window was being dragged).
                const bgApplyMove = () => {
                    bgMoveRaf = null;
                    const pos = bgMovePending;
                    bgMovePending = null;
                    if (!pos) return;
                    bgWinPos = { x: pos.x, y: pos.y };
                    bgWinPosStamp = Date.now();
                    bgPositionWallpaper();

                    // Dragged somewhere new — re-sample what's behind once
                    // the drag settles (only while the sampler is active).
                    if (bgBehindTimer) {
                        clearTimeout(bgMoveSampleTimer);
                        bgMoveSampleTimer = setTimeout(bgSampleBehind, 400);
                    }

                    // Dragged onto ANOTHER display: the backdrop's screen
                    // alignment — and, for the live capture, the source screen
                    // itself — is now wrong, so re-sync as soon as the drag
                    // pauses. Same-display drags no longer pay for this: the
                    // alignment they need is just the transform above.
                    const backdropOn = !!document.querySelector('#bg-backdrop .bg-active');
                    if (backdropOn && pos.displayId && bgBackdropDisplayId && pos.displayId !== bgBackdropDisplayId) {
                        clearTimeout(bgMoveDisplayTimer);
                        bgMoveDisplayTimer = setTimeout(() => {
                            if (bgLiveStream) bgLiveEnsure(true);
                            else applyBackground();   // re-resolves frost for the new display
                        }, 250);
                    }
                };

                window.electronAPI.onWindowMoved((pos) => {
                    bgMovePending = pos;
                    if (!bgMoveRaf) bgMoveRaf = requestAnimationFrame(bgApplyMove);
                });
            }
            applyBackground();
        })();
