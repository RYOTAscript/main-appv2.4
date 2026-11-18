// ── Draw on Screen overlay ──
// The page inside the drawing overlay (screen-draw.html). Everything it knows
// arrives from main over window.screenDraw (screen-draw-preload.js); the
// geometry and undo history come from window.DrawEngine (draw-engine.js).
//
// Three canvases, bottom to top: #bg holds the frozen frame (empty while
// live), #ink the finished strokes, #wet the stroke being drawn and any laser
// trails still fading. Finishing a stroke paints it onto #ink once; only undo,
// redo, erase and a resize repaint #ink from the history. Nothing runs between
// strokes — the animation frame loop only exists while something is moving.

(function () {
    'use strict';

    const E = window.DrawEngine;
    const api = window.screenDraw;
    if (!E || !api) return;

    const $ = (id) => document.getElementById(id);
    const els = {
        body: document.body,
        bg: $('bg'), ink: $('ink'), wet: $('wet'),
        cursor: $('cursor'),
        bar: $('bar'), grip: $('grip'),
        swatches: $('swatches'), sizes: $('sizes'),
        undo: $('undo'), redo: $('redo'), clear: $('clear'),
        live: $('mode-live'), freeze: $('mode-freeze'),
        through: $('through'), copy: $('copy'), save: $('save'), close: $('close'),
        toast: $('toast')
    };
    const toolButtons = [...document.querySelectorAll('[data-tool]')];
    const ctx = { bg: els.bg.getContext('2d'), ink: els.ink.getContext('2d'), wet: els.wet.getContext('2d') };

    const st = {
        tool: 'pen', color: E.COLORS[0], width: E.WIDTHS[1],
        mode: 'live', frozen: null, passThrough: false, busy: false,
        history: E.createHistory(),
        drawing: null,        // the stroke under the pointer
        erasing: null,        // strokes the eraser has touched this drag
        lasers: [],           // finished laser trails, fading
        dpr: 1, w: 0, h: 0, raf: 0,
        overBar: false, hotkey: '', freezeAvailable: true,
        barX: 0.5, barEdge: 'top', lastTool: 'pen'
    };
    let toastTimer = null;

    // ── Painting ────────────────────────────────────────────────────────────

    function size() {
        st.dpr = window.devicePixelRatio || 1;
        st.w = window.innerWidth;
        st.h = window.innerHeight;
        for (const name of ['bg', 'ink', 'wet']) {
            const c = els[name];
            c.width = Math.round(st.w * st.dpr);
            c.height = Math.round(st.h * st.dpr);
            ctx[name].setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        }
        paintBg();
        paintInk();
        paintWet(performance.now());
        placeBar();
    }

    function paintBg() {
        const c = ctx.bg;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, els.bg.width, els.bg.height);
        if (st.frozen) c.drawImage(st.frozen, 0, 0, els.bg.width, els.bg.height);
        c.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    }

    function penPath(c, s) {
        const pts = s.points;
        if (pts.length === 1) {
            c.beginPath();
            c.arc(pts[0][0], pts[0][1], E.pressureWidth(s.width, pts[0][2]) / 2, 0, Math.PI * 2);
            c.fill();
            return;
        }
        const segs = E.smoothPath(pts);
        const varies = pts.some((p) => Math.abs(p[2] - pts[0][2]) > 0.04);
        if (!varies) {
            c.lineWidth = E.pressureWidth(s.width, pts[0][2]);
            c.beginPath();
            c.moveTo(segs[0].x0, segs[0].y0);
            for (let i = 1; i < segs.length; i++) c.quadraticCurveTo(segs[i].cx, segs[i].cy, segs[i].x, segs[i].y);
            c.stroke();
            return;
        }
        // A pen that presses harder draws wider: each curve gets its own width.
        let x = segs[0].x0;
        let y = segs[0].y0;
        for (let i = 1; i < segs.length; i++) {
            c.lineWidth = E.pressureWidth(s.width, pts[Math.min(i, pts.length - 1)][2]);
            c.beginPath();
            c.moveTo(x, y);
            c.quadraticCurveTo(segs[i].cx, segs[i].cy, segs[i].x, segs[i].y);
            c.stroke();
            x = segs[i].x;
            y = segs[i].y;
        }
    }

    function drawStroke(c, s, alpha) {
        c.save();
        c.globalAlpha = alpha == null ? 1 : alpha;
        c.strokeStyle = s.color;
        c.fillStyle = s.color;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        if (s.tool === 'pen') penPath(c, s);
        else if (s.tool === 'highlighter') {
            c.globalAlpha *= 0.36;
            c.lineCap = 'butt';
            const flat = Object.assign({}, s, { points: s.points.map((p) => [p[0], p[1], 0.5]) });
            penPath(c, flat);
        } else if (s.tool === 'laser') {
            c.shadowColor = s.color;
            c.shadowBlur = 14;
            penPath(c, Object.assign({}, s, { points: s.points.map((p) => [p[0], p[1], 0.5]) }));
            c.shadowBlur = 0;
            c.strokeStyle = 'rgba(255,255,255,0.85)';
            c.fillStyle = 'rgba(255,255,255,0.85)';
            penPath(c, Object.assign({}, s, { width: Math.max(1, s.width * 0.35), points: s.points.map((p) => [p[0], p[1], 0.5]) }));
        } else if (s.tool === 'line' || s.tool === 'arrow') {
            c.lineWidth = s.width;
            c.beginPath();
            c.moveTo(s.a[0], s.a[1]);
            c.lineTo(s.b[0], s.b[1]);
            c.stroke();
            if (s.tool === 'arrow') {
                const head = E.arrowHead(s.a, s.b, s.width);
                c.beginPath();
                c.moveTo(head[0][0], head[0][1]);
                c.lineTo(head[1][0], head[1][1]);
                c.lineTo(head[2][0], head[2][1]);
                c.stroke();
            }
        } else if (s.tool === 'rect') {
            c.lineWidth = s.width;
            const x = Math.min(s.a[0], s.b[0]);
            const y = Math.min(s.a[1], s.b[1]);
            c.beginPath();
            c.rect(x, y, Math.abs(s.b[0] - s.a[0]), Math.abs(s.b[1] - s.a[1]));
            c.stroke();
        } else if (s.tool === 'ellipse') {
            c.lineWidth = s.width;
            c.beginPath();
            c.ellipse((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, Math.abs(s.b[0] - s.a[0]) / 2, Math.abs(s.b[1] - s.a[1]) / 2, 0, 0, Math.PI * 2);
            c.stroke();
        }
        c.restore();
    }

    function paintInk() {
        const c = ctx.ink;
        c.clearRect(0, 0, st.w, st.h);
        for (const s of st.history.strokes) {
            if (st.erasing && st.erasing.has(s)) continue;
            drawStroke(c, s);
        }
    }

    // What the pointer is drawing right now, as it will look once finished.
    function wetStroke() {
        const d = st.drawing;
        if (!d) return null;
        if (E.SHAPES.includes(d.tool)) {
            const g = E.shapeFrom(d.tool, d.a, d.b, d.constrain);
            return { tool: d.tool, color: d.color, width: d.width, a: g.a, b: g.b };
        }
        return d;
    }

    function paintWet(now) {
        const c = ctx.wet;
        c.clearRect(0, 0, st.w, st.h);
        st.lasers = st.lasers.filter((s) => E.laserAlpha(s, now) > 0);
        for (const s of st.lasers) drawStroke(c, s, E.laserAlpha(s, now));
        const s = wetStroke();
        if (s) drawStroke(c, s);
    }

    // One frame loop, and only while something is moving.
    function kick() {
        if (st.raf) return;
        const loop = (now) => {
            paintWet(now);
            st.raf = st.drawing || st.lasers.length ? requestAnimationFrame(loop) : 0;
        };
        st.raf = requestAnimationFrame(loop);
    }

    // ── Drawing ─────────────────────────────────────────────────────────────

    const pressure = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

    function strokeWidth() {
        return st.tool === 'highlighter' ? st.width * 3 : st.tool === 'laser' ? Math.max(4, st.width) : st.width;
    }

    function eraserRadius() {
        return Math.max(9, st.width * 2);
    }

    function eraseAt(p) {
        let hit = false;
        for (const s of st.history.strokes) {
            if (!st.erasing.has(s) && E.touches(s, p, eraserRadius())) {
                st.erasing.add(s);
                hit = true;
            }
        }
        if (hit) paintInk();
    }

    function startStroke(e) {
        const p = [e.clientX, e.clientY, pressure(e)];
        els.body.classList.add('is-drawing');
        if (st.tool === 'eraser') {
            st.erasing = new Set();
            eraseAt(p);
            return;
        }
        if (E.SHAPES.includes(st.tool)) {
            st.drawing = { tool: st.tool, color: st.color, width: st.width, a: p, b: p, constrain: e.shiftKey };
        } else {
            st.drawing = { tool: st.tool, color: st.color, width: strokeWidth(), points: [p] };
        }
        kick();
    }

    function moveStroke(e) {
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const all = events.length ? events : [e];
        if (st.erasing) {
            for (const ev of all) eraseAt([ev.clientX, ev.clientY]);
            return;
        }
        const d = st.drawing;
        if (!d) return;
        if (d.points) {
            for (const ev of all) {
                const last = d.points[d.points.length - 1];
                const p = [ev.clientX, ev.clientY, pressure(ev)];
                if ((p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2 >= 0.64) d.points.push(p);
            }
        } else {
            d.b = [e.clientX, e.clientY];
            d.constrain = e.shiftKey;
        }
        kick();
    }

    function endStroke() {
        els.body.classList.remove('is-drawing');
        if (st.erasing) {
            if (st.erasing.size) E.eraseStrokes(st.history, [...st.erasing]);
            st.erasing = null;
            paintInk();
            updateButtons();
            return;
        }
        const d = st.drawing;
        st.drawing = null;
        if (!d) return;
        let s = null;
        if (d.points) {
            s = { tool: d.tool, color: d.color, width: d.width, points: d.tool === 'laser' ? d.points : E.simplify(d.points, 0.5) };
        } else {
            const g = E.shapeFrom(d.tool, d.a, d.b, d.constrain);
            if (Math.abs(g.b[0] - g.a[0]) + Math.abs(g.b[1] - g.a[1]) >= 3) s = { tool: d.tool, color: d.color, width: d.width, a: g.a, b: g.b };
        }
        if (s && s.tool === 'laser') {
            s.endedAt = performance.now();
            st.lasers.push(s);
        } else if (s) {
            E.addStroke(st.history, s);
            drawStroke(ctx.ink, s);
        }
        kick();
        updateButtons();
    }

    els.wet.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (st.drawing || st.erasing) return;
        try { els.wet.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        startStroke(e);
    });
    els.wet.addEventListener('pointermove', (e) => {
        moveCursor(e.clientX, e.clientY);
        moveStroke(e);
    });
    els.wet.addEventListener('pointerup', endStroke);
    els.wet.addEventListener('pointercancel', endStroke);
    els.wet.addEventListener('pointerleave', () => els.cursor.classList.remove('is-on'));
    els.wet.addEventListener('pointerenter', () => els.cursor.classList.add('is-on'));
    els.wet.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── The brush cursor ────────────────────────────────────────────────────

    function styleCursor() {
        const eraser = st.tool === 'eraser';
        const d = eraser ? eraserRadius() * 2 : Math.max(6, strokeWidth());
        els.cursor.style.width = `${d}px`;
        els.cursor.style.height = `${d}px`;
        els.cursor.classList.toggle('is-eraser', eraser);
        document.documentElement.style.setProperty('--ink', st.color);
    }

    function moveCursor(x, y) {
        els.cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        els.cursor.classList.add('is-on');
    }

    // ── Toolbar ─────────────────────────────────────────────────────────────

    function buildBar() {
        for (const color of E.COLORS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'swatch';
            b.dataset.color = color;
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-label', `Colour ${E.COLORS.indexOf(color) + 1}`);
            b.style.setProperty('--c', color);
            b.addEventListener('click', () => setColor(color));
            els.swatches.appendChild(b);
        }
        for (const w of E.WIDTHS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'size';
            b.dataset.width = String(w);
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-label', `Size ${E.WIDTHS.indexOf(w) + 1}`);
            const dot = document.createElement('i');
            const d = Math.min(16, 3 + w * 0.7);
            dot.style.width = `${d}px`;
            dot.style.height = `${d}px`;
            b.appendChild(dot);
            b.addEventListener('click', () => setWidth(w));
            els.sizes.appendChild(b);
        }
        for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));
        els.undo.addEventListener('click', doUndo);
        els.redo.addEventListener('click', doRedo);
        els.clear.addEventListener('click', doClear);
        els.live.addEventListener('click', () => setMode('live'));
        els.freeze.addEventListener('click', () => setMode('freeze'));
        els.through.addEventListener('click', () => api.passThrough(!st.passThrough));
        els.copy.addEventListener('click', () => output('copy'));
        els.save.addEventListener('click', () => output('save'));
        els.close.addEventListener('click', () => api.close());
        els.toast.addEventListener('click', () => { if (els.toast.classList.contains('is-link')) api.reveal(); });
        wireGrip();
    }

    function updateButtons() {
        for (const b of toolButtons) b.classList.toggle('is-on', b.dataset.tool === st.tool);
        for (const b of els.swatches.children) {
            const on = b.dataset.color === st.color;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', String(on));
        }
        for (const b of els.sizes.children) {
            const on = Number(b.dataset.width) === st.width;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', String(on));
        }
        els.undo.disabled = !st.history.undo.length;
        els.redo.disabled = !st.history.redo.length;
        els.clear.disabled = !st.history.strokes.length;
        const frozen = st.mode === 'freeze';
        els.live.classList.toggle('is-on', !frozen);
        els.freeze.classList.toggle('is-on', frozen);
        els.live.disabled = st.busy;
        els.freeze.disabled = st.busy || !st.freezeAvailable;
        els.through.hidden = frozen;
        els.through.classList.toggle('is-on', st.passThrough);
        els.body.classList.toggle('is-frozen', frozen);
        els.body.classList.toggle('is-through', st.passThrough);
        styleCursor();
    }

    function setTool(tool) {
        if (!E.TOOLS.includes(tool)) return;
        if (tool !== 'eraser') st.lastTool = tool;
        st.tool = tool;
        updateButtons();
        if (tool !== 'eraser') api.setPrefs({ tool });
    }

    function setColor(color) {
        st.color = color;
        if (st.tool === 'eraser') st.tool = st.lastTool;
        updateButtons();
        api.setPrefs({ color, tool: st.tool });
    }

    function setWidth(width) {
        st.width = width;
        updateButtons();
        api.setPrefs({ width });
    }

    function stepWidth(dir) {
        const i = E.WIDTHS.indexOf(st.width);
        setWidth(E.WIDTHS[Math.max(0, Math.min(E.WIDTHS.length - 1, i + dir))]);
    }

    function doUndo() { if (E.undo(st.history)) { paintInk(); updateButtons(); } }
    function doRedo() { if (E.redo(st.history)) { paintInk(); updateButtons(); } }
    function doClear() {
        if (E.clearAll(st.history)) {
            paintInk();
            updateButtons();
            toast('Cleared', 'Ctrl+Z brings it back');
        }
    }

    // Freeze: main takes the overlay off the screen for a moment, photographs
    // what's underneath, and the page paints it behind the ink. The drawing
    // carries over either way.
    async function setMode(mode) {
        if (st.busy || mode === st.mode) return;
        if (mode === 'live') {
            st.mode = 'live';
            st.frozen = null;
            api.unfreeze();
            paintBg();
            updateButtons();
            return;
        }
        st.busy = true;
        updateButtons();
        const r = await api.freeze();
        st.busy = false;
        if (r && r.ok && r.image) {
            st.frozen = await loadImage(r.image);
            st.mode = st.frozen ? 'freeze' : 'live';
            paintBg();
        } else {
            explain(r && r.note);
        }
        updateButtons();
    }

    function loadImage(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    // Save or copy. A frozen drawing is the frame plus the ink, put together
    // here; a live one is the screen itself with the drawing on it, so the
    // toolbar steps aside for the moment main takes the picture.
    async function output(kind) {
        if (st.busy) return;
        st.busy = true;
        let payload;
        if (st.frozen) {
            const c = document.createElement('canvas');
            c.width = els.bg.width;
            c.height = els.bg.height;
            const g = c.getContext('2d');
            g.drawImage(els.bg, 0, 0);
            g.drawImage(els.ink, 0, 0);
            payload = { image: c.toDataURL('image/png') };
        } else {
            els.body.classList.add('is-capturing');
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            payload = { live: true };
        }
        const r = await (kind === 'copy' ? api.copy(payload) : api.save(payload));
        els.body.classList.remove('is-capturing');
        st.busy = false;
        if (!r || !r.ok) toast((r && r.error) || 'That didn’t work');
        else if (kind === 'copy') toast('Copied', 'Paste it anywhere');
        else toast('Saved to Pictures › main drawings', 'Click to show it', true);
    }

    // Dragging the toolbar by its grip: anywhere along the top or the bottom.
    function wireGrip() {
        let dragging = false;
        els.grip.addEventListener('pointerdown', (e) => {
            dragging = true;
            try { els.grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
        els.grip.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            st.barX = Math.min(1, Math.max(0, e.clientX / Math.max(1, st.w)));
            st.barEdge = e.clientY > st.h / 2 ? 'bottom' : 'top';
            placeBar();
        });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            api.setPrefs({ barX: st.barX, barEdge: st.barEdge });
        };
        els.grip.addEventListener('pointerup', end);
        els.grip.addEventListener('pointercancel', end);
    }

    function placeBar() {
        const half = els.bar.offsetWidth / 2;
        const x = Math.min(st.w - half - 8, Math.max(half + 8, st.barX * st.w));
        els.bar.style.left = `${x}px`;
        els.bar.classList.toggle('at-bottom', st.barEdge === 'bottom');
    }

    // In click-through the window ignores the mouse except while it is over
    // the toolbar, so the toolbar keeps working.
    document.addEventListener('mousemove', (e) => {
        const over = els.bar.contains(e.target);
        if (over !== st.overBar) {
            st.overBar = over;
            els.body.classList.toggle('over-bar', over);
            if (st.passThrough) api.hoverUi(over);
        }
    });

    // ── Messages ────────────────────────────────────────────────────────────

    function toast(text, sub, link) {
        clearTimeout(toastTimer);
        els.toast.textContent = text;
        if (sub) {
            const small = document.createElement('small');
            small.textContent = sub;
            els.toast.appendChild(small);
        }
        els.toast.classList.toggle('is-link', !!link);
        els.toast.classList.add('is-on');
        toastTimer = setTimeout(() => els.toast.classList.remove('is-on', 'is-link'), link ? 4500 : 2600);
    }

    function explain(note) {
        if (note === 'mac-permission') toast('Freezing needs Screen Recording permission', 'System Settings › Privacy & Security — drawing live for now');
        else if (note === 'capture-failed') toast('Couldn’t freeze the screen', 'Drawing live instead');
    }

    function hotkeyText(accel) {
        return accel ? String(accel).replace(/CommandOrControl|Control/g, 'Ctrl') : 'the hotkey';
    }

    // ── Keys ────────────────────────────────────────────────────────────────

    const TOOL_KEYS = { p: 'pen', h: 'highlighter', k: 'laser', a: 'arrow', l: 'line', r: 'rect', o: 'ellipse', e: 'eraser' };

    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (key === 'escape') { api.close(); return; }
        if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
        if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
        if (mod && key === 's') { e.preventDefault(); output('save'); return; }
        if (mod && key === 'c') { e.preventDefault(); output('copy'); return; }
        if (mod || e.altKey) return;
        if (key === 'delete' || key === 'backspace') { doClear(); return; }
        if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); return; }
        if (/^[1-8]$/.test(key)) { setColor(E.COLORS[Number(key) - 1]); return; }
        if (key === '[' || key === '-') { stepWidth(-1); return; }
        if (key === ']' || key === '=' || key === '+') { stepWidth(1); return; }
        if (key === 'f') { setMode(st.mode === 'freeze' ? 'live' : 'freeze'); return; }
        if (key === 't' && st.mode === 'live') api.passThrough(!st.passThrough);
    });

    api.onState((s) => {
        if (!s || typeof s !== 'object') return;
        st.passThrough = !!s.passThrough;
        if (!st.passThrough) { st.overBar = false; els.body.classList.remove('over-bar'); }
        updateButtons();
        if (st.passThrough) toast('Clicks go through to your apps', `Your drawing stays — T or ${hotkeyText(st.hotkey)} to draw again`);
    });

    window.addEventListener('resize', size);

    // ── Start ───────────────────────────────────────────────────────────────

    buildBar();
    api.ready().then(async (init) => {
        if (!init) return;
        const p = E.sanitizePrefs(init.prefs);
        st.tool = p.tool;
        st.lastTool = p.tool;
        st.color = p.color;
        st.width = p.width;
        st.barX = p.barX;
        st.barEdge = p.barEdge;
        st.hotkey = init.prefs && init.prefs.hotkey;
        st.freezeAvailable = init.freezeAvailable !== false;
        st.mode = init.mode === 'freeze' && init.image ? 'freeze' : 'live';
        if (st.mode === 'freeze') st.frozen = await loadImage(init.image);
        if (!st.frozen) st.mode = 'live';
        size();
        updateButtons();
        // Painted, frame and all: main can show the window now.
        requestAnimationFrame(() => api.painted());
        if (init.note) explain(init.note);
        else if (st.mode === 'live') toast('Drawing on your screen', `Esc or ${hotkeyText(st.hotkey)} to close · F freezes it`);
        else toast('Screen frozen — draw on it', `Esc or ${hotkeyText(st.hotkey)} to close · F goes live`);
    }).catch(() => api.close());
})();
