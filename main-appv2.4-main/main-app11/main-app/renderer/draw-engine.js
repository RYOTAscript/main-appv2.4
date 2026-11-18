// ── Draw on Screen engine (pure) ──
// Loaded BOTH as a <script> in the drawing overlay (window.DrawEngine) and via
// require() from main/screenDraw.js — one copy of the settings rules, the
// stroke geometry and the undo history, so the overlay and the process that
// opens it can never disagree. Same split as the Timers and Study engines.
//
// Nothing in here touches the DOM, Electron or the clock: every function takes
// what it needs as arguments (test/draw-engine.test.js).

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.DrawEngine = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // pen: freehand, follows pen pressure. highlighter: wide, see-through,
    // flat ends. laser: a pointer trail that fades on its own. line, arrow,
    // rect, ellipse: shapes (Shift keeps them straight / square / round).
    // eraser: removes whole strokes it touches.
    const TOOLS = ['pen', 'highlighter', 'laser', 'line', 'arrow', 'rect', 'ellipse', 'eraser'];
    const SHAPES = ['line', 'arrow', 'rect', 'ellipse'];
    const MODES = ['live', 'freeze'];
    const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];
    const WIDTHS = [2, 4, 7, 12, 20];
    const DEFAULT_HOTKEY = 'CommandOrControl+Alt+D';
    const LASER_FADE_MS = 1400;
    const MAX_STROKES = 2000;
    const MAX_POINTS = 20000;

    const HEX = /^#[0-9a-f]{6}$/i;

    function sanitizePrefs(raw) {
        const r = raw && typeof raw === 'object' ? raw : {};
        const accel = (v, fallback) => (typeof v === 'string' && v.length <= 60 && /^[\w+]*$/.test(v) ? v : fallback);
        return {
            enabled: r.enabled === true,
            hotkey: accel(r.hotkey, DEFAULT_HOTKEY),
            // Optional second hotkey that opens straight in the OTHER mode.
            hotkeyAlt: accel(r.hotkeyAlt, ''),
            mode: MODES.includes(r.mode) ? r.mode : 'live',
            tool: TOOLS.includes(r.tool) && r.tool !== 'eraser' ? r.tool : 'pen',
            color: typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : COLORS[0],
            width: WIDTHS.includes(r.width) ? r.width : WIDTHS[1],
            // Where the toolbar sits: a fraction of the screen width, top or bottom.
            barX: Number.isFinite(r.barX) ? Math.min(1, Math.max(0, r.barX)) : 0.5,
            barEdge: r.barEdge === 'bottom' ? 'bottom' : 'top'
        };
    }

    // The other mode: the alternative hotkey opens in it.
    function otherMode(mode) {
        return mode === 'freeze' ? 'live' : 'freeze';
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    const dist2 = (a, b) => (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);

    // Distance² from p to the segment ab.
    function segDist2(p, a, b) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        if (!len2) return dist2(p, a);
        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return dist2(p, [a[0] + t * dx, a[1] + t * dy]);
    }

    // Ramer–Douglas–Peucker: drops points that lie within `tolerance` px of the
    // line through their neighbours, so a long stroke stays light to redraw.
    function simplify(points, tolerance) {
        if (!Array.isArray(points) || points.length < 3) return (points || []).slice();
        const tol2 = (tolerance || 0.6) * (tolerance || 0.6);
        const keep = new Uint8Array(points.length);
        keep[0] = 1;
        keep[points.length - 1] = 1;
        const stack = [[0, points.length - 1]];
        while (stack.length) {
            const [s, e] = stack.pop();
            let max = 0;
            let at = -1;
            for (let i = s + 1; i < e; i++) {
                const d = segDist2(points[i], points[s], points[e]);
                if (d > max) { max = d; at = i; }
            }
            if (at !== -1 && max > tol2) {
                keep[at] = 1;
                stack.push([s, at], [at, e]);
            }
        }
        return points.filter((_, i) => keep[i]);
    }

    // A freehand stroke as smooth curves: each point becomes the control point
    // of a quadratic curve between the midpoints either side of it. Returns
    // [{ x0, y0 }, { cx, cy, x, y }…] — start, then curve-to segments.
    function smoothPath(points) {
        const p = points || [];
        if (!p.length) return [];
        if (p.length === 1) return [{ x0: p[0][0], y0: p[0][1] }];
        const out = [{ x0: p[0][0], y0: p[0][1] }];
        for (let i = 1; i < p.length - 1; i++) {
            out.push({ cx: p[i][0], cy: p[i][1], x: (p[i][0] + p[i + 1][0]) / 2, y: (p[i][1] + p[i + 1][1]) / 2 });
        }
        const last = p[p.length - 1];
        out.push({ cx: last[0], cy: last[1], x: last[0], y: last[1] });
        return out;
    }

    // Pen pressure (0..1; a mouse reports 0.5) → line width.
    function pressureWidth(base, pressure) {
        const p = Number.isFinite(pressure) && pressure > 0 ? Math.min(1, pressure) : 0.5;
        return Math.max(0.5, base * (0.45 + p * 1.1));
    }

    // Two corners of a drag → the shape's geometry. With `constrain` (Shift):
    // a line snaps to the nearest 45°, a rectangle becomes a square and an
    // ellipse a circle.
    function shapeFrom(tool, a, b, constrain) {
        let end = [b[0], b[1]];
        if (constrain) {
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            if (tool === 'line' || tool === 'arrow') {
                const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
                const len = Math.hypot(dx, dy);
                end = [a[0] + Math.cos(angle) * len, a[1] + Math.sin(angle) * len];
            } else {
                const side = Math.max(Math.abs(dx), Math.abs(dy));
                end = [a[0] + Math.sign(dx || 1) * side, a[1] + Math.sign(dy || 1) * side];
            }
        }
        return { a: [a[0], a[1]], b: end };
    }

    // The arrowhead of a line from a to b drawn `width` px thick: the two back
    // corners, sized to the line, so it never looks pinned on.
    function arrowHead(a, b, width) {
        const len = Math.max(10, width * 3.2 + 6);
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const spread = Math.PI / 7;
        return [
            [b[0] - len * Math.cos(angle - spread), b[1] - len * Math.sin(angle - spread)],
            [b[0], b[1]],
            [b[0] - len * Math.cos(angle + spread), b[1] - len * Math.sin(angle + spread)]
        ];
    }

    // Points along a shape's outline, for the eraser to test against.
    function outline(stroke) {
        if (!SHAPES.includes(stroke.tool)) return stroke.points || [];
        const [x0, y0] = stroke.a;
        const [x1, y1] = stroke.b;
        if (stroke.tool === 'line' || stroke.tool === 'arrow') return [stroke.a, stroke.b];
        if (stroke.tool === 'rect') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = Math.abs(x1 - x0) / 2;
        const ry = Math.abs(y1 - y0) / 2;
        const pts = [];
        for (let i = 0; i <= 32; i++) {
            const t = (i / 32) * Math.PI * 2;
            pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
        return pts;
    }

    // Whether the eraser at `p` (radius r) touches the stroke.
    function touches(stroke, p, r) {
        const pts = outline(stroke);
        const reach = r + (stroke.width || 2) / 2;
        const reach2 = reach * reach;
        if (pts.length === 1) return dist2(p, pts[0]) <= reach2;
        for (let i = 1; i < pts.length; i++) {
            if (segDist2(p, pts[i - 1], pts[i]) <= reach2) return true;
        }
        return false;
    }

    // ── History ─────────────────────────────────────────────────────────────
    // The drawing is a list of strokes plus an undo/redo trail of what each step
    // did: added a stroke, erased some, or cleared everything. Clearing is
    // undoable too — one stray Delete shouldn't cost a whole diagram.

    function createHistory() {
        return { strokes: [], undo: [], redo: [] };
    }

    function trim(h) {
        if (h.strokes.length > MAX_STROKES) h.strokes.splice(0, h.strokes.length - MAX_STROKES);
        if (h.undo.length > 200) h.undo.splice(0, h.undo.length - 200);
    }

    function addStroke(h, stroke) {
        if (!stroke) return h;
        h.strokes.push(stroke);
        h.undo.push({ kind: 'add', stroke });
        h.redo = [];
        trim(h);
        return h;
    }

    function eraseStrokes(h, doomed) {
        const gone = new Set(doomed || []);
        if (!gone.size) return false;
        const removed = [];
        h.strokes = h.strokes.filter((s, i) => {
            if (!gone.has(s)) return true;
            removed.push({ stroke: s, at: i });
            return false;
        });
        if (!removed.length) return false;
        h.undo.push({ kind: 'erase', removed });
        h.redo = [];
        return true;
    }

    function clearAll(h) {
        if (!h.strokes.length) return false;
        h.undo.push({ kind: 'clear', strokes: h.strokes });
        h.strokes = [];
        h.redo = [];
        return true;
    }

    function undo(h) {
        const step = h.undo.pop();
        if (!step) return false;
        if (step.kind === 'add') h.strokes = h.strokes.filter((s) => s !== step.stroke);
        else if (step.kind === 'clear') h.strokes = step.strokes.slice();
        else if (step.kind === 'erase') {
            for (const { stroke, at } of step.removed) h.strokes.splice(Math.min(at, h.strokes.length), 0, stroke);
        }
        h.redo.push(step);
        return true;
    }

    function redo(h) {
        const step = h.redo.pop();
        if (!step) return false;
        if (step.kind === 'add') h.strokes.push(step.stroke);
        else if (step.kind === 'clear') h.strokes = [];
        else if (step.kind === 'erase') {
            const gone = new Set(step.removed.map((r) => r.stroke));
            h.strokes = h.strokes.filter((s) => !gone.has(s));
        }
        h.undo.push(step);
        return true;
    }

    // Laser strokes still glowing at `now`, with how faded each is (1 → 0).
    function laserAlpha(stroke, now) {
        if (!stroke || stroke.tool !== 'laser' || !Number.isFinite(stroke.endedAt)) return 1;
        const t = (now - stroke.endedAt) / LASER_FADE_MS;
        return t >= 1 ? 0 : 1 - t * t;
    }

    // A stroke as it should be kept: plain numbers only, within limits.
    function sanitizeStroke(s) {
        if (!s || typeof s !== 'object' || !TOOLS.includes(s.tool) || s.tool === 'eraser') return null;
        const color = typeof s.color === 'string' && HEX.test(s.color) ? s.color : COLORS[0];
        const width = Number.isFinite(s.width) ? Math.min(60, Math.max(0.5, s.width)) : WIDTHS[1];
        const pt = (p) => (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0.5] : null);
        if (SHAPES.includes(s.tool)) {
            const a = pt(s.a);
            const b = pt(s.b);
            return a && b ? { tool: s.tool, color, width, a: [a[0], a[1]], b: [b[0], b[1]] } : null;
        }
        const points = (Array.isArray(s.points) ? s.points.slice(0, MAX_POINTS) : []).map(pt).filter(Boolean);
        return points.length ? { tool: s.tool, color, width, points } : null;
    }

    return {
        TOOLS, SHAPES, MODES, COLORS, WIDTHS, DEFAULT_HOTKEY, LASER_FADE_MS, MAX_STROKES,
        sanitizePrefs, otherMode,
        segDist2, simplify, smoothPath, pressureWidth, shapeFrom, arrowHead, outline, touches,
        createHistory, addStroke, eraseStrokes, clearAll, undo, redo, laserAlpha, sanitizeStroke
    };
});
