'use strict';

// renderer/study-engine.js — the Study widget's rules: the shorthand → LaTeX
// converter, what a stored sheet may hold, and floating-window geometry.
// Formulas are rendered here with the REAL vendored KaTeX (+ mhchem), so a
// starter sheet that would show a red error box in the app fails the build.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'renderer', 'study-engine.js'));

// KaTeX + mhchem exactly as the overlay page loads them: two classic scripts
// sharing one global.
function loadKatex() {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['katex.min.js', 'contrib/mhchem.min.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'styles', 'vendor', 'katex', f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.katex;
}
const katex = loadKatex();

// ── The shorthand ──────────────────────────────────────────────────────────

const CASES = [
  // fractions: juxtaposition binds tighter than /, a space ends a side,
  // brackets around a whole side are dropped
  ['a/b', '\\frac{a}{b}'],
  ['mv^2/r', '\\frac{m v^{2}}{r}'],
  ['1/2 mv^2', '\\frac{1}{2} m v^{2}'],
  ['(a+b)/(2c)', '\\frac{a + b}{2 c}'],
  ['(a + b) / 2', '\\frac{a + b}{2}'],
  ['a/b/c', '\\frac{\\frac{a}{b}}{c}'],
  ['dy/dx', '\\frac{d y}{d x}'],
  ['x = (-b +- sqrt(b^2 - 4ac))/(2a)', 'x = \\frac{- b \\pm \\sqrt{b^{2} - 4 a c}}{2 a}'],
  // powers and subscripts
  ['x^2', 'x^{2}'],
  ['x^(n+1)', 'x^{n + 1}'],
  ['x**2', 'x^{2}'],
  ['e^-x', 'e^{-x}'],
  ['e^-x^2', 'e^{-x^{2}}'],
  ['x^2 - 1', 'x^{2} - 1'],
  ['x^2-1', 'x^{2} - 1'],
  ['H^+', 'H^{+}'],
  ['SO_4^2-', 'S O_{4}^{2-}'],
  ['x_1', 'x_{1}'],
  ['P_1V_1', 'P_{1} V_{1}'],
  ['v_max', 'v_{\\max}'],
  ['E_cell', 'E_{\\mathrm{cell}}'],
  ['S_oo', 'S_{\\infty}'],
  ['theta_1', '\\theta_{1}'],
  ['t_(1/2)', 't_{\\frac{1}{2}}'],
  // names
  ['pi r^2', '\\pi r^{2}'],
  ['sinx', '\\sin x'],
  ['sin^2 x + cos^2 x = 1', '\\sin^{2} x + \\cos^{2} x = 1'],
  ['Delta G', '\\Delta G'],
  ['log_a x', '\\log_{a} x'],
  ['lim_(x->0)', '\\lim_{x \\to 0}'],
  ['sum_(k=0)^n', '\\sum_{k = 0}^{n}'],
  ['int_a^b f(x) dx', '\\int_{a}^{b} f (x) d x'],
  ['oo inf', '\\infty \\infty'],
  ['30 deg', '30 \\degree'],
  // operators
  ['a <= b >= c != d ~= e', 'a \\le b \\ge c \\ne d \\approx e'],
  ['a -> b => c <=> d', 'a \\to b \\Rightarrow c \\Leftrightarrow d'],
  ['a +- b -+ c', 'a \\pm b \\mp c'],
  ['a*b', 'a \\cdot b'],
  ['6.02*10^23', '6.02 \\times 10^{23}'],
  ['1, 2, ...', '1 , 2 , \\dots'],
  ['F = ma,  p = mv', 'F = m a , \\quad p = m v'],
  ['50%', '50 \\%'],
  // functions
  ['sqrt x', '\\sqrt{x}'],
  ['sqrt2', '\\sqrt{2}'],
  ['cbrt(27)', '\\sqrt[3]{27}'],
  ['root(3)(x)', '\\sqrt[3]{x}'],
  ['root(3, x)', '\\sqrt[3]{x}'],
  ['abs(x-1)', '\\left|x - 1\\right|'],
  ['vec(F) = m vec(a)', '\\vec{F} = m \\vec{a}'],
  ['bar(x)', '\\overline{x}'],
  ['binom(n, k)', '\\binom{n}{k}'],
  ['1 bar', '1 b a r'],
  // text and chemistry
  ['"opp"/"hyp"', '\\frac{\\text{opp}}{\\text{hyp}}'],
  ['"50% & more"', '\\text{50\\% \\& more}'],
  ['ce(2H2 + O2 -> 2H2O)', '\\ce{2H2 + O2 -> 2H2O}'],
  // brackets grow around a fraction
  ['(1 + 1/x)^x', '{\\left( 1 + \\frac{1}{x} \\right)}^{x}'],
  // Unicode the renderer can't take is translated
  ['√2', '\\sqrt{2}'],
  ['x≤3', 'x \\le 3']
];

test('the shorthand converts the way a student would expect', () => {
  for (const [src, tex] of CASES) assert.equal(E.toTex(src), tex, src);
});

test('LaTeX passes straight through, and a \\text{} argument is never rewritten', () => {
  assert.equal(E.toTex('\\frac{a}{b}'), '\\frac {a} {b}');
  assert.equal(E.toTex('x^{2}'), 'x^{2}');
  // "pin" would become \pi n if this argument were parsed as maths.
  assert.equal(E.toTex('\\text{pin and sin}'), '\\text{pin and sin}');
  assert.equal(E.toTex('\\mathrm{pH}'), '\\mathrm{pH}');
  // A bare % in a text argument is a TeX comment that would eat the brace.
  assert.equal(E.toTex('\\text{50%}'), '\\text{50\\%}');
  // \left … \right written by hand is left alone (no doubled \left).
  assert.equal(E.toTex('\\left( \\frac{a}{b} \\right)'), '\\left (\\frac {a} {b} \\right)');
  // & is alignment inside an environment, a literal ampersand outside one.
  assert.match(E.toTex('\\begin{pmatrix} a & b \\end{pmatrix}'), /a & b/);
  assert.equal(E.toTex('a & b'), 'a \\& b');
});

test('half-typed input never throws and never hangs', () => {
  for (const s of ['', ' ', '(', ')', '}{', '{', '\\', '"', 'x^', 'x_', '^', '/', '1/', '/2', 'a//b', 'sqrt', 'root(', 'binom(', 'abs(', 'ce(H2O', '"unclosed', '((((((((((', ')))))', '\\frac{', '^^^^', '____']) {
    const tex = E.toTex(s);
    assert.equal(typeof tex, 'string', JSON.stringify(s));
    E.renderFormula(katex, s); // must not throw either
  }
  // Long input is capped, not processed whole.
  assert.ok(E.toTex('x+'.repeat(5000)).length < E.MAX_SRC * 4);
});

// ── Rendering ──────────────────────────────────────────────────────────────

test('every starter formula typesets with the real KaTeX, chemistry included', () => {
  let n = 0;
  for (const st of E.STARTERS) {
    for (const r of st.rows) {
      if (r.kind !== 'formula') continue;
      const out = E.renderFormula(katex, r.src);
      assert.equal(out.error, null, `${st.id}: ${r.src} → ${out.tex} — ${out.error}`);
      assert.ok(out.html.includes('katex'), r.src);
      n++;
    }
  }
  assert.ok(n >= 120, 'a real set of formulas, not a token one');
});

test('the starter sets cover the four subjects, with sound metadata', () => {
  const ids = E.STARTERS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const subject of E.SUBJECTS) assert.ok(E.STARTERS.some(s => s.subject === subject), subject);
  for (const st of E.STARTERS) {
    assert.match(st.color, /^#[0-9a-f]{6}$/);
    assert.ok(st.title && st.blurb, st.id);
    assert.ok(st.rows.filter(r => r.kind === 'formula').length >= 10, st.id);
    assert.ok(st.rows.length <= E.MAX_ROWS);
    for (const r of st.rows) {
      assert.ok(E.ROW_KINDS.includes(r.kind));
      assert.ok(r.src.length <= E.MAX_SRC && r.label.length <= E.MAX_LABEL && r.note.length <= E.MAX_NOTE, r.src);
    }
  }
  // Mixed level, as asked: some first-year university material too.
  assert.ok(E.STARTERS.some(s => s.rows.some(r => r.note === 'university')));
  // Chemistry shows real chemical equations.
  assert.ok(E.STARTERS.find(s => s.id === 'moles').rows.some(r => r.src.startsWith('ce(')));
});

test('the palette and the help card typeset too', () => {
  for (const g of E.PALETTE) {
    for (const it of g.items) {
      const out = E.renderFormula(katex, it.tex);
      assert.equal(out.error, null, it.tex);
      assert.ok(typeof it.ins === 'string' && it.ins.length);
    }
  }
  for (const [code] of E.CHEATSHEET) {
    for (const part of code.split(/\s{2,}/)) {
      // Fragments like "sum_(i=1)^n" render fine on their own.
      assert.equal(E.renderFormula(katex, part).error, null, part);
    }
  }
});

test('a formula can never inject markup or run code', () => {
  assert.equal(E.RENDER_OPTIONS.trust, false);
  assert.ok(Object.isFrozen(E.RENDER_OPTIONS));
  const hostile = [
    '\\href{javascript:alert(1)}{click}',
    '\\url{javascript:alert(1)}',
    '\\htmlClass{x}{y}',
    '\\htmlData{onclick=alert(1)}{y}',
    '\\includegraphics{x.png}',
    '<script>alert(1)</script>',
    '"<img src=x onerror=alert(1)>"',
    'text(<b onmouseover=alert(1)>hi</b>)',
    '\\text{<iframe src=x>}'
  ];
  for (const s of hostile) {
    const out = E.renderFormula(katex, s);
    // Look at the real tags only: the words may survive as ESCAPED text
    // (&lt;img …&gt;), which is exactly what should happen to them.
    const tags = out.html.match(/<[^>]*>/g) || [];
    for (const tag of tags) {
      assert.match(tag, /^<\/?(span|svg|path|line|rect|g)\b/i, s + ' → ' + tag);
      assert.ok(!/\son[a-z]+\s*=/i.test(tag), s + ' → ' + tag);
      assert.ok(!/javascript:/i.test(tag), s + ' → ' + tag);
    }
  }
  // (KaTeX writes the spaces in \text{} as no-break spaces, hence \s.)
  assert.match(E.renderFormula(katex, '"<img src=x onerror=alert(1)>"').html, /&lt;img\s+src=x\s+onerror=alert\(1\)&gt;/, 'shown as text');
});

test('macros are contained: a loop is cut off and a \\gdef never leaks', () => {
  const loop = E.renderFormula(katex, '\\def\\a{\\a}\\a');
  assert.ok(loop.error, 'infinite expansion reports an error instead of hanging');
  assert.equal(E.renderFormula(katex, '\\gdef\\leak{X}\\leak').error, null);
  assert.ok(E.renderFormula(katex, '\\leak').error, 'the macro did not survive into the next formula');
  const huge = E.renderFormula(katex, '\\rule{9999em}{9999em}');
  assert.ok(!/9999em/.test(huge.html), 'sizes are capped');
});

test('renderFormula reports instead of throwing', () => {
  assert.deepEqual(E.renderFormula(katex, '   '), { html: '', tex: '', error: null });
  const noKatex = E.renderFormula(null, 'x^2');
  assert.equal(noKatex.html, '');
  assert.equal(noKatex.tex, 'x^{2}');
  assert.ok(noKatex.error);
  const bad = E.renderFormula(katex, '\\frac{');
  assert.equal(bad.html, '');
  assert.ok(bad.error && bad.error.length <= 140);
});

// ── Stored data ────────────────────────────────────────────────────────────

test('a missing or broken store comes back as a clean, disabled default', () => {
  for (const raw of [null, undefined, 42, 'x', [], { sheets: 'nope', floats: 7, settings: null }]) {
    const s = E.sanitizeStore(raw, 1000, 0.5);
    assert.equal(s.version, E.STORE_VERSION);
    assert.equal(s.enabled, false);
    assert.deepEqual(s.sheets, []);
    assert.deepEqual(s.floats, {});
    assert.deepEqual(s.settings, E.mergeSettings(null, null));
    assert.equal(s.focusId, null);
  }
});

test('sanitizeStore drops what does not belong and keeps what does', () => {
  const raw = {
    enabled: true,
    focusId: 'gone',
    sheets: [
      { id: 'a', title: '  Algebra  ', subject: 'Maths', color: '#ABCDEF', rows: [
        { id: 'r1', kind: 'formula', label: 'L', src: 'x^2\n+1', note: 'n', junk: 1 },
        { id: 'r1', kind: 'formula', src: 'dup id gets a fresh one' },
        { kind: 'heading', label: 'H', src: 'ignored' },
        { id: 'r3', kind: 'weird', src: 'y' },
        'not a row'
      ] },
      { id: 'a', title: 'duplicate sheet id' },
      { id: 'bad id!', title: 'gets a minted id' },
      null,
      { id: 'b', color: 'red', rows: Array.from({ length: E.MAX_ROWS + 20 }, (_, i) => ({ id: 'x' + i, src: 'x'.repeat(E.MAX_SRC + 50) })) }
    ],
    floats: { a: { x: 10, y: 20, width: 50, height: 5000, opacity: 3, scale: 9, style: 'neon', ghost: 'yes', open: true }, zzz: { x: 1 } },
    settings: { floatStyle: 'paper', floatScale: 0.1, floatOpacity: 500, hotkeyToggle: 'Control+Alt+F', hotkeyGhost: 'rm -rf /' }
  };
  const s = E.sanitizeStore(raw, 5000, 0.25);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.sheets.map(x => x.id).slice(0, 1), ['a']);
  assert.equal(s.sheets.length, 3, 'duplicate id dropped, null dropped, bad id minted');
  const a = s.sheets[0];
  assert.equal(a.title, 'Algebra');
  assert.equal(a.color, '#abcdef');
  assert.equal(a.rows[0].src, 'x^2 +1', 'one line');
  assert.equal(a.rows[0].junk, undefined);
  assert.notEqual(a.rows[1].id, 'r1', 'a duplicate row id is replaced');
  assert.equal(a.rows[2].kind, 'heading');
  assert.equal(a.rows[2].src, '', 'only formulas carry a source');
  assert.equal(a.rows[3].kind, 'formula', 'unknown kinds become formulas');
  assert.equal(a.rows.length, 4);
  const b = s.sheets.find(x => x.id === 'b');
  assert.equal(b.rows.length, E.MAX_ROWS);
  assert.equal(b.rows[0].src.length, E.MAX_SRC);
  assert.equal(b.color, E.COLORS[0]);
  assert.equal(b.title, 'Untitled sheet');
  assert.equal(b.subject, 'Other');
  // Floats: only for sheets that exist, every field clamped.
  assert.deepEqual(Object.keys(s.floats), ['a']);
  const f = s.floats.a;
  assert.equal(f.width, E.FLOAT_MIN.width);
  assert.equal(f.height, 4000);
  assert.equal(f.opacity, E.OPACITY_MIN);
  assert.equal(f.scale, E.SCALE_MAX);
  assert.equal(f.style, 'paper', 'falls back to the settings default');
  assert.equal(f.ghost, false);
  assert.equal(f.open, true);
  // Settings.
  assert.equal(s.settings.floatScale, E.SCALE_MIN);
  assert.equal(s.settings.floatOpacity, 100);
  assert.equal(s.settings.hotkeyToggle, 'Control+Alt+F');
  assert.equal(s.settings.hotkeyGhost, '', 'not an accelerator');
  assert.equal(s.focusId, null, 'focus on a sheet that no longer exists is cleared');
});

test('a sanitised store survives a round trip unchanged', () => {
  const st = E.sheetFromStarter('algebra', 1000, 0.3);
  const once = E.sanitizeStore({ enabled: true, sheets: [st], floats: { [st.id]: { x: 5, y: 6, open: true } }, focusId: st.id }, 2000, 0.1);
  const twice = E.sanitizeStore(JSON.parse(JSON.stringify(once)), 3000, 0.9);
  assert.deepEqual(twice, once);
});

test('a starter copy gets fresh, unique ids and remembers where it came from', () => {
  const a = E.sheetFromStarter('trig', 1000, 0.1);
  const b = E.sheetFromStarter('trig', 1000, 0.2);
  assert.equal(a.starter, 'trig');
  assert.notEqual(a.id, b.id);
  const ids = a.rows.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(a.rows.length, E.STARTERS.find(s => s.id === 'trig').rows.length);
  assert.equal(E.sheetFromStarter('nope', 1, 0.5), null);
});

test('settings merge and float prefs clamp', () => {
  const s = E.mergeSettings({ floatStyle: 'clear', showLabels: false }, { floatOpacity: 40, floatScale: 1.26 });
  assert.equal(s.floatStyle, 'clear');
  assert.equal(s.showLabels, false);
  assert.equal(s.floatOpacity, 40);
  assert.equal(s.floatScale, 1.3);
  const f = E.sanitizeFloat({ labels: false }, s);
  assert.equal(f.labels, false);
  assert.equal(f.notes, true);
  assert.equal(f.style, 'clear');
  assert.equal(f.opacity, 40);
  assert.equal(f.x, undefined, 'no position until the window has one');
  assert.deepEqual([f.width, f.height], [E.FLOAT_DEFAULT.width, E.FLOAT_DEFAULT.height]);
  assert.equal(E.roundScale('abc'), 1);
});

test('search and subject grouping', () => {
  const sheets = E.sanitizeStore({ sheets: [
    { id: 'p', title: 'Waves', subject: 'Physics', rows: [{ id: 'r', src: 'v = f lambda', label: 'Wave equation' }] },
    { id: 'm', title: 'Algebra', subject: 'Maths', rows: [] },
    { id: 'z', title: 'Misc', subject: 'Other', rows: [] },
    { id: 'b', title: 'Cells', subject: 'Biology', rows: [] }
  ] }, 1, 0.5).sheets;
  assert.deepEqual(E.groupBySubject(sheets).map(g => g.subject), ['Maths', 'Physics', 'Biology', 'Other']);
  assert.ok(E.matchesQuery(sheets[0], 'wave lambda'));
  assert.ok(E.matchesQuery(sheets[0], 'PHYSICS'));
  assert.ok(!E.matchesQuery(sheets[0], 'algebra'));
  assert.ok(E.matchesQuery(sheets[0], '  '));
  assert.equal(E.countFormulas(sheets[0]), 1);
});

// ── Geometry ───────────────────────────────────────────────────────────────

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test('a window is clamped onto its screen and never below the minimum size', () => {
  assert.deepEqual(E.clampToArea({ x: -50, y: 2000, width: 300, height: 400 }, AREA), { x: 0, y: 640, width: 300, height: 400 });
  assert.deepEqual(E.clampToArea({ x: 10, y: 10, width: 50, height: 20 }, AREA), { x: 10, y: 10, width: E.FLOAT_MIN.width, height: E.FLOAT_MIN.height });
  assert.deepEqual(E.clampToArea({ x: 0, y: 0, width: 5000, height: 5000 }, AREA), { x: 0, y: 0, width: 1920, height: 1040 });
  // A second monitor to the left (negative coordinates).
  const left = { x: -1280, y: 0, width: 1280, height: 1000 };
  assert.deepEqual(E.clampToArea({ x: -100, y: 10, width: 300, height: 300 }, left), { x: -300, y: 10, width: 300, height: 300 });
});

test('the resize grip keeps the top-left corner and stays on the screen', () => {
  const b = { x: 1500, y: 600, width: 340, height: 420 };
  assert.deepEqual(E.resizeWithin(b, 380, 300, AREA), { x: 1500, y: 600, width: 380, height: 300 });
  assert.deepEqual(E.resizeWithin(b, 5, 5, AREA), { x: 1500, y: 600, width: E.FLOAT_MIN.width, height: E.FLOAT_MIN.height });
  assert.deepEqual(E.resizeWithin(b, 9000, 9000, AREA), { x: 1500, y: 600, width: 420, height: 440 });
  assert.deepEqual(E.resizeWithin(b, NaN, 'x', AREA), b);
});

test('corners and moving between displays', () => {
  assert.deepEqual(E.cornerPosition(AREA, { width: 300, height: 400 }, 'top-right', 24), { x: 1596, y: 24 });
  assert.deepEqual(E.cornerPosition(AREA, { width: 300, height: 400 }, 'bottom-left', 16), { x: 16, y: 624 });
  assert.deepEqual(E.cornerPosition(AREA, { width: 300, height: 400 }, 'nonsense', 16), { x: 1604, y: 16 });
  const other = { x: 1920, y: 0, width: 2560, height: 1400 };
  const moved = E.mapToArea({ x: 1620, y: 0, width: 300, height: 400 }, AREA, other);
  assert.deepEqual(moved, { x: 1920 + 2260, y: 0, width: 300, height: 400 }, 'top-right stays top-right');
});

test('the engine is pure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'study-engine.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  for (const banned of ['Math.random', 'Date.now', 'document.', 'require(', 'setTimeout', 'innerHTML']) {
    assert.ok(!src.includes(banned), banned);
  }
});
