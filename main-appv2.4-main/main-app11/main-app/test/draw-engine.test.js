'use strict';

// Draw on Screen's pure rules (renderer/draw-engine.js): settings, stroke
// geometry and the undo history. Shared by the overlay page and
// main/screenDraw.js, so a mistake here shows up in both.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const E = require(path.join(__dirname, '..', 'renderer', 'draw-engine.js'));

test('settings default safely and reject junk', () => {
  const d = E.sanitizePrefs(null);
  assert.equal(d.enabled, false, 'off until switched on');
  assert.equal(d.hotkey, 'CommandOrControl+Alt+D', 'a hotkey nothing else in main uses');
  assert.equal(d.hotkeyAlt, '');
  assert.equal(d.mode, 'live');
  assert.equal(d.tool, 'pen');
  assert.ok(E.COLORS.includes(d.color));
  assert.ok(E.WIDTHS.includes(d.width));
  const junk = E.sanitizePrefs({
    enabled: 'yes', hotkey: 'Ctrl+<script>', mode: 'melt', tool: 'eraser', color: 'red', width: 999,
    barX: 7, barEdge: 'left'
  });
  assert.equal(junk.enabled, false, 'only a real true');
  assert.equal(junk.hotkey, E.DEFAULT_HOTKEY, 'an accelerator is word characters and + only');
  assert.equal(junk.mode, 'live');
  assert.equal(junk.tool, 'pen', 'never starts on the eraser');
  assert.equal(junk.color, E.COLORS[0]);
  assert.equal(junk.width, E.WIDTHS[1]);
  assert.equal(junk.barX, 1, 'clamped onto the screen');
  assert.equal(junk.barEdge, 'top');
  assert.equal(E.sanitizePrefs({ hotkey: '' }).hotkey, '', 'a cleared hotkey stays cleared');
  assert.equal(E.sanitizePrefs({ color: '#ABCDEF' }).color, '#abcdef');
  assert.equal(E.otherMode('live'), 'freeze');
  assert.equal(E.otherMode('freeze'), 'live');
});

test('long strokes are thinned without losing their shape', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([i, 0, 0.5]);
  assert.deepEqual(E.simplify(line, 0.5).map((p) => p[0]), [0, 100], 'a straight run is two points');
  const corner = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  assert.deepEqual(E.simplify(corner, 0.5), [[0, 0], [10, 0], [10, 10]], 'the corner stays');
  assert.equal(E.simplify([[1, 1]], 0.5).length, 1);
  assert.deepEqual(E.simplify([], 0.5), []);
});

test('freehand strokes become smooth curves through midpoints', () => {
  assert.deepEqual(E.smoothPath([]), []);
  assert.deepEqual(E.smoothPath([[3, 4]]), [{ x0: 3, y0: 4 }], 'a dot');
  const segs = E.smoothPath([[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(segs[0], { x0: 0, y0: 0 });
  assert.deepEqual(segs[1], { cx: 10, cy: 0, x: 10, y: 5 }, 'each point is a control point between midpoints');
  assert.deepEqual(segs[2], { cx: 10, cy: 10, x: 10, y: 10 }, 'and the stroke ends where the pen lifted');
});

test('pen pressure widens the line; a mouse draws at the set size', () => {
  assert.equal(E.pressureWidth(10, 0.5), 10, 'a mouse (0.5) is the size you picked');
  assert.ok(E.pressureWidth(10, 1) > 15);
  assert.ok(E.pressureWidth(10, 0.1) < 6);
  assert.equal(E.pressureWidth(10, NaN), 10);
  assert.ok(E.pressureWidth(1, 0.01) >= 0.5, 'never vanishes');
});

test('Shift keeps shapes neat', () => {
  const free = E.shapeFrom('rect', [0, 0], [30, 10], false);
  assert.deepEqual(free.b, [30, 10]);
  assert.deepEqual(E.shapeFrom('rect', [0, 0], [30, 10], true).b, [30, 30], 'a square');
  assert.deepEqual(E.shapeFrom('ellipse', [0, 0], [-30, 10], true).b, [-30, 30], 'a circle, whichever way you drag');
  const line = E.shapeFrom('line', [0, 0], [100, 8], true).b;
  assert.ok(Math.abs(line[1]) < 1e-9 && Math.abs(line[0] - Math.hypot(100, 8)) < 1e-9, 'snapped flat');
  const diag = E.shapeFrom('arrow', [0, 0], [50, 47], true).b;
  assert.ok(Math.abs(diag[0] - diag[1]) < 1e-9, 'snapped to 45°');
});

test('an arrowhead sits on the tip and scales with the line', () => {
  const head = E.arrowHead([0, 0], [100, 0], 4);
  assert.deepEqual(head[1], [100, 0]);
  assert.ok(head[0][0] < 100 && head[2][0] < 100, 'pointing back along the line');
  assert.ok(head[0][1] * head[2][1] < 0, 'one barb each side');
  const thick = E.arrowHead([0, 0], [100, 0], 20);
  assert.ok(100 - thick[0][0] > 100 - head[0][0], 'a thicker line, a bigger head');
});

test('the eraser touches what is under it, shapes included', () => {
  const stroke = { tool: 'pen', width: 4, points: [[0, 0], [100, 0]] };
  assert.ok(E.touches(stroke, [50, 8], 6));
  assert.ok(!E.touches(stroke, [50, 30], 6));
  const rect = { tool: 'rect', width: 2, a: [0, 0], b: [100, 50] };
  assert.ok(E.touches(rect, [100, 25], 4), 'on its edge');
  assert.ok(!E.touches(rect, [50, 25], 4), 'not through its middle');
  const ring = { tool: 'ellipse', width: 2, a: [0, 0], b: [100, 100] };
  assert.ok(E.touches(ring, [50, 0], 4));
  assert.ok(!E.touches(ring, [50, 50], 4));
  assert.ok(E.touches({ tool: 'pen', width: 4, points: [[10, 10]] }, [12, 10], 2), 'a single dot');
});

test('undo and redo cover drawing, erasing and clearing', () => {
  const h = E.createHistory();
  const a = { tool: 'pen', points: [[0, 0]] };
  const b = { tool: 'pen', points: [[5, 5]] };
  const c = { tool: 'rect', a: [0, 0], b: [1, 1] };
  E.addStroke(h, a);
  E.addStroke(h, b);
  E.addStroke(h, c);
  assert.deepEqual(h.strokes, [a, b, c]);
  assert.ok(E.eraseStrokes(h, [b]));
  assert.deepEqual(h.strokes, [a, c]);
  assert.ok(E.clearAll(h));
  assert.deepEqual(h.strokes, []);
  assert.ok(E.undo(h), 'the clear comes back');
  assert.deepEqual(h.strokes, [a, c]);
  assert.ok(E.undo(h), 'so does the erased stroke, in its place');
  assert.deepEqual(h.strokes, [a, b, c]);
  assert.ok(E.undo(h));
  assert.deepEqual(h.strokes, [a, b]);
  assert.ok(E.redo(h));
  assert.ok(E.redo(h));
  assert.deepEqual(h.strokes, [a, c]);
  assert.ok(E.redo(h));
  assert.deepEqual(h.strokes, []);
  assert.equal(E.redo(h), false, 'nothing left to redo');
  E.undo(h);
  E.addStroke(h, b);
  assert.equal(h.redo.length, 0, 'a new stroke ends the redo trail');
  assert.equal(E.clearAll(E.createHistory()), false, 'clearing nothing is not a step');
  assert.equal(E.eraseStrokes(h, []), false);
});

test('a laser trail fades out on its own', () => {
  const s = { tool: 'laser', endedAt: 1000 };
  assert.equal(E.laserAlpha(s, 1000), 1);
  assert.ok(E.laserAlpha(s, 1000 + E.LASER_FADE_MS / 2) < 1);
  assert.equal(E.laserAlpha(s, 1000 + E.LASER_FADE_MS), 0);
  assert.equal(E.laserAlpha({ tool: 'laser' }, 5000), 1, 'still being drawn');
  assert.equal(E.laserAlpha({ tool: 'pen' }, 5000), 1);
});

test('a stroke is plain numbers within limits, or nothing', () => {
  assert.deepEqual(E.sanitizeStroke({ tool: 'pen', color: '#ff0000', width: 4, points: [[1, 2, 0.7], ['x', 2], [3, 4]] }),
    { tool: 'pen', color: '#ff0000', width: 4, points: [[1, 2, 0.7], [3, 4, 0.5]] });
  assert.deepEqual(E.sanitizeStroke({ tool: 'arrow', color: 'javascript:x', width: 900, a: [0, 0], b: [5, 5] }),
    { tool: 'arrow', color: E.COLORS[0], width: 60, a: [0, 0], b: [5, 5] });
  assert.equal(E.sanitizeStroke({ tool: 'eraser', points: [[1, 1]] }), null);
  assert.equal(E.sanitizeStroke({ tool: 'pen', points: [] }), null);
  assert.equal(E.sanitizeStroke(null), null);
});
