        // ── Crosshair drawing (shared) ──
        // Pure canvas renderer used by BOTH the on-screen overlay window
        // (crosshair-overlay.html) and the live preview inside Settings
        // (renderer/crosshair.js), so what you see in the preview is exactly
        // what the overlay draws. No DOM access, no state — just (ctx, w, h, cfg).

        const CROSSHAIR_DEFAULTS = {
            style: 'cross',   // cross | tshape | xshape | circle | dot
            color: '#00ff7f',
            opacity: 0.9,     // 0.1 .. 1
            size: 12,         // arm length / circle radius / dot diameter (px)
            gap: 5,           // distance from center to arm start (px)
            thickness: 2,     // arm/ring thickness (px)
            outline: true,    // 1px black outline for visibility on bright scenes
            dot: false,       // independent center dot (any style)
            dotSize: 3        // center-dot radius (px)
        };

        function drawCrosshair(ctx, w, h, cfg) {
            const c = Object.assign({}, CROSSHAIR_DEFAULTS, cfg || {});
            const cx = w / 2;
            const cy = h / 2;
            const t = Math.max(1, Number(c.thickness) || 1);
            const s = Math.max(1, Number(c.size) || 1);
            const g = Math.max(0, Number(c.gap) || 0);

            ctx.clearRect(0, 0, w, h);
            ctx.save();
            ctx.globalAlpha = Math.max(0.05, Math.min(1, Number(c.opacity) || 1));

            // Cross / T arms as [x, y, w, h] rects. T-shape = cross minus the top arm.
            const arms = [];
            if (c.style === 'cross' || c.style === 'tshape') {
                if (c.style === 'cross') arms.push([cx - t / 2, cy - g - s, t, s]); // top
                arms.push([cx - t / 2, cy + g, t, s]);                              // bottom
                arms.push([cx - g - s, cy - t / 2, s, t]);                          // left
                arms.push([cx + g, cy - t / 2, s, t]);                              // right
            }

            // Diagonal segments for the X style, as [x1, y1, x2, y2] lines.
            const diagonals = [];
            if (c.style === 'xshape') {
                const k = Math.SQRT1_2; // project the gap/size onto a 45° diagonal
                for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                    diagonals.push([
                        cx + dx * g * k, cy + dy * g * k,
                        cx + dx * (g + s) * k, cy + dy * (g + s) * k
                    ]);
                }
            }

            const strokeLine = (x1, y1, x2, y2, width, style) => {
                ctx.strokeStyle = style;
                ctx.lineWidth = width;
                ctx.lineCap = 'butt';
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            };
            const fillCircle = (r, style) => {
                ctx.fillStyle = style;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fill();
            };
            const strokeCircle = (r, width, style) => {
                ctx.strokeStyle = style;
                ctx.lineWidth = width;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
            };

            // Outline pass first, color pass second — so outlines never sit on top
            // of an adjacent element's color when parts touch (e.g. gap = 0).
            if (c.outline) {
                ctx.fillStyle = '#000';
                for (const [x, y, ww, hh] of arms) ctx.fillRect(x - 1, y - 1, ww + 2, hh + 2);
                for (const [x1, y1, x2, y2] of diagonals) strokeLine(x1, y1, x2, y2, t + 2, '#000');
                if (c.style === 'circle') strokeCircle(Math.max(2, s), t + 2, '#000');
                if (c.style === 'dot') fillCircle(Math.max(1, s / 2) + 1, '#000');
                if (c.dot && c.style !== 'dot') fillCircle(Math.max(1, Number(c.dotSize) || 1) + 1, '#000');
            }

            ctx.fillStyle = c.color;
            for (const [x, y, ww, hh] of arms) ctx.fillRect(x, y, ww, hh);
            for (const [x1, y1, x2, y2] of diagonals) strokeLine(x1, y1, x2, y2, t, c.color);
            if (c.style === 'circle') strokeCircle(Math.max(2, s), t, c.color);
            if (c.style === 'dot') fillCircle(Math.max(1, s / 2), c.color);
            if (c.dot && c.style !== 'dot') fillCircle(Math.max(1, Number(c.dotSize) || 1), c.color);

            ctx.restore();
        }
