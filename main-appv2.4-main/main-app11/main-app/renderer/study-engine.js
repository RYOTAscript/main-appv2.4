// ── Study engine (pure) ──
// Loaded BOTH as a renderer <script> (window.StudyEngine) — by the library
// panel and by every floating formula sheet (study-float.html) — and via
// require() from main/study.js. One copy of the rules: what a sheet may hold,
// how the easy shorthand turns into LaTeX, and how a floating sheet's window
// is kept on screen. Same split as the Timers and the Calendar.
//
// Nothing in here touches the DOM, Electron, timers or Math.random: ids take a
// `now` and a random number from the caller, and KaTeX is passed IN to
// renderFormula(), so the whole module runs under node:test
// (test/study-engine.test.js renders every starter formula with the real
// vendored KaTeX).
//
// The shorthand. Students type `x = (-b +- sqrt(b^2 - 4ac))/(2a)` and get the
// quadratic formula, not plain text. toTex() is a small tokenizer + parser:
//   a/b         fraction. Juxtaposition binds tighter than `/`, so mv^2/r is
//               (mv²)/r; a SPACE ends the numerator/denominator, so 1/2 mv^2 is
//               ½·mv². A bracketed side loses its brackets: (a+b)/(2c).
//   x^2 x^(n+1) superscript; e^-x, H^+, SO_4^2- (a trailing +/- with nothing
//               after it is a charge, so x^2-1 is still x² − 1). ** works too.
//   x_1 v_max   subscript; a word of letters becomes upright (v_max → v_{max}).
//   sqrt cbrt root(n)(x) abs(x) vec(F) hat bar dot binom(n, k)
//   sin cos tan ln log lim sum int … become operators; alpha … Omega, pi,
//   oo/inf (∞), deg (°), hbar, nabla, partial, +- <= >= != ~= -> => <=>
//   "quoted words" are upright text; ce(2H2 + O2 -> 2H2O) is a chemical
//   equation (KaTeX's mhchem); two or more spaces leave a visible gap, so
//   "F = ma,  p = mv" keeps two formulas apart on one line.
// LaTeX is accepted as-is alongside all of that: a \command passes straight
// through, and the text argument of \text{}, \ce{}, \mathrm{} … is never
// touched. Nothing here can make KaTeX run code — rendering is always done
// with trust: false (see RENDER_OPTIONS).

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.StudyEngine = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const STORE_VERSION = 1;
    const MAX_SHEETS = 60;
    const MAX_ROWS = 150;
    const MAX_SRC = 600;
    const MAX_LABEL = 80;
    const MAX_NOTE = 240;
    const MAX_TITLE = 60;
    const MAX_SUBJECT = 30;
    const MAX_FLOATS = 4;
    const ROW_KINDS = ['formula', 'heading', 'text'];
    const SUBJECTS = ['Maths', 'Calculus', 'Physics', 'Chemistry'];
    const COLORS = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#a3e635'];
    const STYLES = ['glass', 'paper', 'clear'];
    const SCALE_MIN = 0.6;
    const SCALE_MAX = 2.4;
    const OPACITY_MIN = 25;
    // A floating sheet is never smaller than this, nor bigger than its screen.
    const FLOAT_MIN = Object.freeze({ width: 200, height: 120 });
    const FLOAT_DEFAULT = Object.freeze({ width: 340, height: 420 });
    const CORNERS = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'];

    const DEFAULT_SETTINGS = Object.freeze({
        floatStyle: 'glass',
        floatScale: 1,
        floatOpacity: 100,
        showLabels: true,
        showNotes: true,
        hotkeyToggle: '',
        hotkeyGhost: ''
    });

    // KaTeX options used EVERYWHERE a formula is drawn. trust: false keeps
    // \href, \url, \includegraphics and \html* inert; maxExpand stops a
    // \def loop; maxSize caps \rule and friends. A fresh `macros` object is
    // passed per render (renderFormula) so a \gdef in one formula can never
    // leak into the next.
    const RENDER_OPTIONS = Object.freeze({
        displayMode: false,
        output: 'html',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxSize: 10,
        maxExpand: 300,
        globalGroup: false
    });

    // ── Small sanitisers ────────────────────────────────────────────────────

    function cleanText(v, max) {
        if (typeof v !== 'string') return '';
        // Control characters out (newlines included — every field is one line).
        return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    }

    function cleanSrc(v) {
        if (typeof v !== 'string') return '';
        return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_SRC);
    }

    function cleanId(v) {
        return typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : '';
    }

    function cleanColor(v, fallback) {
        return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : (fallback || COLORS[0]);
    }

    // Electron accelerator text as the renderer produces it. Empty = unbound.
    function cleanAccel(a) {
        return typeof a === 'string' && /^[A-Za-z0-9+;'=,.\/`\[\]\\-]{1,60}$/.test(a) && a !== '-' ? a : '';
    }

    function clampNum(v, lo, hi, fallback) {
        const n = Number(v);
        if (v === null || v === '' || !Number.isFinite(n)) return fallback;
        return Math.min(hi, Math.max(lo, n));
    }

    function roundScale(v) {
        return Math.round(clampNum(v, SCALE_MIN, SCALE_MAX, 1) * 10) / 10;
    }

    function newId(prefix, now, rand) {
        const r = Math.floor((Number.isFinite(rand) ? rand : 0.5) * 2176782336).toString(36);
        return prefix + Math.floor(Number(now) || 0).toString(36) + r;
    }

    // ── Rows and sheets ─────────────────────────────────────────────────────

    function sanitizeRow(raw, mintId) {
        if (!raw || typeof raw !== 'object') return null;
        const kind = ROW_KINDS.includes(raw.kind) ? raw.kind : 'formula';
        const id = cleanId(raw.id) || (mintId ? mintId() : '');
        if (!id) return null;
        const label = cleanText(raw.label, kind === 'text' ? MAX_NOTE : MAX_LABEL);
        if (kind === 'formula') {
            return { id, kind, label, src: cleanSrc(raw.src), note: cleanText(raw.note, MAX_NOTE) };
        }
        return { id, kind, label, src: '', note: '' };
    }

    function sanitizeRows(list, mintId) {
        const out = [];
        const seen = new Set();
        for (const r of Array.isArray(list) ? list : []) {
            if (out.length >= MAX_ROWS) break;
            let row = sanitizeRow(r, mintId);
            if (!row) continue;
            if (seen.has(row.id)) {
                if (!mintId) continue;
                row = Object.assign({}, row, { id: mintId() });
            }
            seen.add(row.id);
            out.push(row);
        }
        return out;
    }

    function sanitizeSheet(raw, now, mintId) {
        if (!raw || typeof raw !== 'object') return null;
        const id = cleanId(raw.id) || (mintId ? mintId() : '');
        if (!id) return null;
        const t = Math.floor(Number(now) || 0);
        const created = Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0 ? Math.floor(Number(raw.createdAt)) : t;
        const updated = Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Math.floor(Number(raw.updatedAt)) : created;
        return {
            id,
            title: cleanText(raw.title, MAX_TITLE) || 'Untitled sheet',
            subject: cleanText(raw.subject, MAX_SUBJECT) || 'Other',
            color: cleanColor(raw.color),
            starter: cleanId(raw.starter),
            rows: sanitizeRows(raw.rows, mintId),
            createdAt: created,
            updatedAt: updated
        };
    }

    function mergeSettings(base, patch) {
        const b = base && typeof base === 'object' ? base : {};
        const p = patch && typeof patch === 'object' ? patch : {};
        const pick = (k) => (k in p ? p[k] : (k in b ? b[k] : DEFAULT_SETTINGS[k]));
        const style = pick('floatStyle');
        return {
            floatStyle: STYLES.includes(style) ? style : DEFAULT_SETTINGS.floatStyle,
            floatScale: roundScale(pick('floatScale')),
            floatOpacity: Math.round(clampNum(pick('floatOpacity'), OPACITY_MIN, 100, 100)),
            showLabels: pick('showLabels') !== false,
            showNotes: pick('showNotes') !== false,
            hotkeyToggle: cleanAccel(pick('hotkeyToggle')),
            hotkeyGhost: cleanAccel(pick('hotkeyGhost'))
        };
    }

    // Per-sheet floating window prefs. Look fields fall back to the settings'
    // defaults until the user picks something for that window.
    function sanitizeFloat(raw, settings) {
        const s = settings || DEFAULT_SETTINGS;
        const r = raw && typeof raw === 'object' ? raw : {};
        const out = {
            style: STYLES.includes(r.style) ? r.style : s.floatStyle,
            scale: 'scale' in r ? roundScale(r.scale) : s.floatScale,
            opacity: Math.round(clampNum('opacity' in r ? r.opacity : s.floatOpacity, OPACITY_MIN, 100, 100)),
            ghost: r.ghost === true,
            labels: 'labels' in r ? r.labels !== false : s.showLabels,
            notes: 'notes' in r ? r.notes !== false : s.showNotes,
            open: r.open === true,
            width: Math.round(clampNum(r.width, FLOAT_MIN.width, 4000, FLOAT_DEFAULT.width)),
            height: Math.round(clampNum(r.height, FLOAT_MIN.height, 4000, FLOAT_DEFAULT.height))
        };
        if (Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)) && r.x !== null && r.y !== null && r.x !== '' && r.y !== '') {
            out.x = Math.round(Number(r.x));
            out.y = Math.round(Number(r.y));
        }
        return out;
    }

    // Everything read from disk (or handed over IPC) goes through here. Unknown
    // fields are dropped, broken sheets are skipped, ids are de-duplicated, and
    // float prefs for sheets that no longer exist are forgotten.
    function sanitizeStore(raw, now, rand) {
        const r = raw && typeof raw === 'object' ? raw : {};
        let n = 0;
        const mint = (prefix) => () => newId(prefix, now, ((Number.isFinite(rand) ? rand : 0.5) + (++n) * 0.618034) % 1);
        const settings = mergeSettings(r.settings, null);
        const sheets = [];
        const seen = new Set();
        for (const s of Array.isArray(r.sheets) ? r.sheets : []) {
            if (sheets.length >= MAX_SHEETS) break;
            const sheet = sanitizeSheet(s, now, mint('r'));
            if (!sheet || seen.has(sheet.id)) continue;
            seen.add(sheet.id);
            sheets.push(sheet);
        }
        const floats = {};
        const rawFloats = r.floats && typeof r.floats === 'object' ? r.floats : {};
        for (const id of Object.keys(rawFloats)) {
            if (seen.has(id)) floats[id] = sanitizeFloat(rawFloats[id], settings);
        }
        return {
            version: STORE_VERSION,
            enabled: r.enabled === true,
            sheets,
            floats,
            settings,
            focusId: seen.has(r.focusId) ? r.focusId : null
        };
    }

    function countFormulas(sheet) {
        return sheet && Array.isArray(sheet.rows) ? sheet.rows.filter(x => x.kind === 'formula' && x.src).length : 0;
    }

    // A starter set copied into the user's own sheets, with fresh ids so the
    // copy is theirs to edit.
    function sheetFromStarter(starterId, now, rand) {
        const st = STARTERS.find(s => s.id === starterId);
        if (!st) return null;
        let n = 0;
        const base = Number.isFinite(rand) ? rand : 0.5;
        const mintRow = () => newId('r', now, (base + (++n) * 0.618034) % 1);
        return sanitizeSheet({
            id: newId('s', now, base),
            title: st.title,
            subject: st.subject,
            color: st.color,
            starter: st.id,
            rows: st.rows.map(row => ({ kind: row.kind, label: row.label, src: row.src, note: row.note })),
            createdAt: now,
            updatedAt: now
        }, now, mintRow);
    }

    function matchesQuery(sheet, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return true;
        const hay = [sheet.title, sheet.subject].concat(sheet.rows.map(r => r.label + ' ' + r.note + ' ' + r.src)).join(' ').toLowerCase();
        return q.split(/\s+/).every(word => hay.includes(word));
    }

    // Sheets grouped by subject: the four built-in subjects first, in order,
    // then the user's own subjects alphabetically.
    function groupBySubject(sheets) {
        const map = new Map();
        for (const s of sheets) {
            if (!map.has(s.subject)) map.set(s.subject, []);
            map.get(s.subject).push(s);
        }
        const rank = (name) => {
            const i = SUBJECTS.indexOf(name);
            return i === -1 ? (name === 'Other' ? 999 : 100) : i;
        };
        return [...map.keys()]
            .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
            .map(subject => ({ subject, sheets: map.get(subject) }));
    }

    // ── Shorthand → LaTeX ───────────────────────────────────────────────────

    const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
        'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi',
        'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];
    const FUNCS = ['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
        'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'arg'];
    const SYMBOL_WORDS = {
        oo: '\\infty', inf: '\\infty', infinity: '\\infty',
        deg: '\\degree', degree: '\\degree', degrees: '\\degree', circ: '\\circ',
        hbar: '\\hbar', nabla: '\\nabla', grad: '\\nabla', partial: '\\partial', del: '\\partial', ell: '\\ell',
        times: '\\times', div: '\\div', cdot: '\\cdot', approx: '\\approx', propto: '\\propto', prop: '\\propto',
        equiv: '\\equiv', therefore: '\\therefore', because: '\\because', angle: '\\angle', perp: '\\perp',
        parallel: '\\parallel', mod: '\\bmod', sum: '\\sum', prod: '\\prod', int: '\\int', iint: '\\iint', oint: '\\oint',
        forall: '\\forall', exists: '\\exists', emptyset: '\\emptyset'
    };
    // Functions that take an argument: sqrt and cbrt take the next atom
    // (`sqrt x`, `sqrt2`); the rest only count when written as a call, f(…) —
    // so `bar` in "1 bar" or `dot` in a word stays plain letters.
    const ARG_FUNCS = ['sqrt', 'cbrt'];
    const CALL_FUNCS = ['root', 'abs', 'norm', 'vec', 'hat', 'bar', 'dot', 'ddot', 'tilde', 'binom', 'overline', 'underline'];
    const ACCENTS = { vec: '\\vec', hat: '\\hat', bar: '\\overline', overline: '\\overline', underline: '\\underline', dot: '\\dot', ddot: '\\ddot', tilde: '\\tilde' };
    // text(...) and ce(...) capture their content raw.
    const RAW_CALLS = ['text', 'ce'];
    // LaTeX commands whose first {} argument is text, not maths.
    const RAW_ARG_CMDS = new Set(['text', 'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'mathrm', 'mathbf', 'mathit',
        'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'operatorname', 'ce', 'pu', 'begin', 'end', 'color', 'textcolor']);
    // LaTeX commands that behave as operators: they end a fraction's
    // numerator/denominator exactly like typing + or = would.
    const OP_CMDS = new Set(['\\cdot', '\\times', '\\div', '\\pm', '\\mp', '\\le', '\\leq', '\\ge', '\\geq', '\\ne', '\\neq',
        '\\approx', '\\equiv', '\\to', '\\rightarrow', '\\leftarrow', '\\Rightarrow', '\\Leftarrow', '\\Leftrightarrow',
        '\\leftrightarrow', '\\sim', '\\simeq', '\\propto', '\\in', '\\notin', '\\subset', '\\cup', '\\cap', '\\quad',
        '\\qquad', '\\,', '\\;', '\\:', '\\!', '\\\\', '\\ ', '\\implies', '\\iff', '\\gets', '\\mapsto', '\\ll', '\\gg',
        '\\lt', '\\gt', '\\coloneqq', '\\land', '\\lor', '\\setminus', '\\circ', '\\bmod']);
    const OPS = [
        ['<=>', '\\Leftrightarrow'], ['<->', '\\leftrightarrow'], ['...', '\\dots'],
        ['<=', '\\le'], ['>=', '\\ge'], ['!=', '\\ne'], ['~=', '\\approx'], ['=>', '\\Rightarrow'], ['->', '\\to'],
        ['+-', '\\pm'], ['-+', '\\mp'], ['**', '^']
    ];
    const UNICODE = { '−': '-', '√': ' sqrt', '∛': ' cbrt', '≤': '<=', '≥': '>=', '≠': '!=' };

    const NAMES = (function () {
        const m = new Map();
        for (const g of GREEK) m.set(g, '\\' + g);
        for (const f of FUNCS) m.set(f, '\\' + f);
        for (const k of Object.keys(SYMBOL_WORDS)) m.set(k, SYMBOL_WORDS[k]);
        for (const f of ARG_FUNCS.concat(CALL_FUNCS)) m.set(f, '');
        return m;
    })();
    const NAME_LIST = [...NAMES.keys()].sort((a, b) => b.length - a.length);

    function matchClose(s, i, open, close) {
        let depth = 0;
        for (let j = i; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] === open) depth++;
            else if (s[j] === close) { depth--; if (depth === 0) return j; }
        }
        return -1;
    }

    // Letters split greedily into known names (longest first) and single
    // letters: "sinx" → sin x, "pir" → pi r, "beta" stays one name.
    function splitWord(word) {
        const out = [];
        let i = 0;
        while (i < word.length) {
            let hit = null;
            for (const name of NAME_LIST) {
                if (word.startsWith(name, i)) { hit = name; break; }
            }
            if (hit) { out.push({ t: 'name', v: hit }); i += hit.length; }
            else { out.push({ t: 'id', v: word[i] }); i++; }
        }
        return out;
    }

    function tokenize(input) {
        let s = String(input || '');
        s = s.replace(/[−√∛≤≥≠]/g, ch => UNICODE[ch]);
        const toks = [];
        let i = 0;
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) {
                const from = i;
                while (i < s.length && /\s/.test(s[i])) i++;
                toks.push({ t: 'space', n: i - from });
                continue;
            }
            if (c === '\\') {
                let j = i + 1;
                if (j < s.length && /[A-Za-z]/.test(s[j])) { while (j < s.length && /[A-Za-z]/.test(s[j])) j++; }
                else if (j < s.length) j++;
                const name = s.slice(i, j);
                if (RAW_ARG_CMDS.has(name.slice(1))) {
                    let k = j;
                    while (k < s.length && s[k] === ' ') k++;
                    if (s[k] === '{') {
                        const end = matchClose(s, k, '{', '}');
                        if (end > 0) {
                            // A bare % is a TeX comment: it would swallow the
                            // closing brace. \text{50%} means a percent sign.
                            toks.push({ t: 'raw', v: name + s.slice(k, end + 1).replace(/(^|[^\\])%/g, '$1\\%') });
                            i = end + 1;
                            continue;
                        }
                    }
                }
                toks.push({ t: 'cmd', v: name });
                i = j;
                continue;
            }
            if (c === '"') {
                const end = s.indexOf('"', i + 1);
                const text = end > i ? s.slice(i + 1, end) : s.slice(i + 1);
                toks.push({ t: 'text', v: text });
                i = end > i ? end + 1 : s.length;
                continue;
            }
            const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i, i + 40));
            if (num) {
                toks.push({ t: 'num', v: num[0] });
                i += num[0].length;
                continue;
            }
            if (/[A-Za-z]/.test(c)) {
                let j = i;
                while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
                const word = s.slice(i, j);
                if (RAW_CALLS.includes(word) && s[j] === '(') {
                    const end = matchClose(s, j, '(', ')');
                    const body = end > 0 ? s.slice(j + 1, end) : s.slice(j + 1);
                    toks.push(word === 'ce' ? { t: 'raw', v: '\\ce{' + chemBody(body) + '}' } : { t: 'text', v: body });
                    i = end > 0 ? end + 1 : s.length;
                    continue;
                }
                const parts = splitWord(word);
                // A call-only function counts only as the LAST part of the
                // word and only when "(" follows straight away.
                parts.forEach((p, k) => {
                    p.src = p.v;
                    if (p.t === 'name') p.call = k === parts.length - 1 && s[j] === '(';
                });
                toks.push(...parts);
                i = j;
                continue;
            }
            let op = null;
            for (const [txt, tex] of OPS) {
                if (s.startsWith(txt, i)) { op = [txt, tex]; break; }
            }
            if (op) {
                toks.push(op[1] === '^' ? { t: 'sym', v: '^' } : { t: 'op', v: op[1], src: op[0] });
                i += op[0].length;
                continue;
            }
            if ('([{'.includes(c)) { toks.push({ t: 'open', v: c }); i++; continue; }
            if (')]}'.includes(c)) { toks.push({ t: 'close', v: c }); i++; continue; }
            toks.push({ t: 'sym', v: c });
            i++;
        }
        return toks;
    }

    // mhchem reads its own syntax; only keep its braces balanced.
    function chemBody(body) {
        let depth = 0;
        let out = '';
        for (const ch of body) {
            if (ch === '{') depth++;
            if (ch === '}') { if (depth === 0) continue; depth--; }
            out += ch === '%' ? '\\%' : ch;
        }
        return out + '}'.repeat(depth);
    }

    function texText(s) {
        return String(s)
            .replace(/\\/g, '')
            .replace(/[{}$%#&_]/g, ch => '\\' + ch)
            .replace(/\^/g, '\\textasciicircum{}')
            .replace(/~/g, '\\textasciitilde{}');
    }

    const CLOSERS = { '(': ')', '[': ']', '{': '}' };
    const TALL = /\\(?:d?frac|sum|prod|int|iint|oint|binom|lim)\b/;

    function toTex(input) {
        const src = cleanSrc(input);
        if (!src) return '';
        const toks = tokenize(src);
        const rawLatex = /\\(?:left|right|big|Big|bigg|Bigg)/.test(src);
        const keepAmp = /\\begin\b/.test(src);
        let pos = 0;

        const peek = (o) => toks[pos + (o || 0)];
        const isSym = (tk, v) => tk && tk.t === 'sym' && tk.v === v;
        const skipSpace = () => { while (peek() && peek().t === 'space') pos++; };

        function symTex(v) {
            if (v === '%' || v === '$' || v === '#') return '\\' + v;
            if (v === '&') return keepAmp ? '&' : '\\&';
            if (v === '~') return '\\sim';
            if (v === '}') return '\\}';
            return v;
        }

        // Brackets around a "tall" inside (a fraction, a sum…) grow to fit.
        function wrap(open, inner, closed) {
            const close = CLOSERS[open];
            const o = open === '{' ? '\\{' : open;
            const c = close === '}' ? '\\}' : close;
            if (!closed) return o + ' ' + inner;
            if (!rawLatex && TALL.test(inner)) return '\\left' + o + ' ' + inner + ' \\right' + c;
            return o + inner + c;
        }

        // A bracketed group. Returns { tex, inner, closed }.
        function group() {
            const open = toks[pos++].v;
            const inner = seq(CLOSERS[open], false);
            const closed = !!(peek() && peek().t === 'close' && peek().v === CLOSERS[open]);
            if (closed) pos++;
            if (open === '{') return { tex: '{' + inner + '}', inner, closed: true, brace: true };
            return { tex: wrap(open, inner, closed), inner, closed, paren: open === '(' };
        }

        // Comma-separated call arguments: binom(n, k), root(3, x).
        function callArgs() {
            pos++; // (
            const args = [seq(')', true)];
            while (isSym(peek(), ',')) { pos++; args.push(seq(')', true)); }
            if (peek() && peek().t === 'close' && peek().v === ')') pos++;
            return args.map(a => a.trim());
        }

        // The argument of sqrt/vec/…: a bracketed group (brackets dropped) or
        // the next single atom.
        function arg() {
            skipSpace();
            const tk = peek();
            if (!tk) return '';
            if (tk.t === 'open' && tk.v !== '[') {
                const g = group();
                return g.closed ? g.inner : g.tex;
            }
            const a = atom();
            return a ? a.tex : '';
        }

        function scriptArg(kind) {
            skipSpace();
            const tk = peek();
            if (!tk) return '';
            if (tk.t === 'open' && tk.v !== '[') {
                const g = group();
                return g.closed ? g.inner : g.tex;
            }
            if (tk.t === 'sym' && (tk.v === '+' || tk.v === '-')) {
                pos++;
                const nx = peek();
                if (nx && (nx.t === 'num' || nx.t === 'id' || nx.t === 'name' || nx.t === 'cmd' || nx.t === 'text' || (nx.t === 'open' && nx.v !== '['))) {
                    return tk.v + scriptArg(kind);
                }
                return tk.v;
            }
            if (kind === 'sub' && (tk.t === 'id' || tk.t === 'name')) {
                // A run of letters is one subscript word: v_max, K_sp, E_cell.
                let word = '';
                while (peek() && (peek().t === 'id' || peek().t === 'name') && !(peek().t === 'name' && peek().call)) {
                    word += peek().src;
                    pos++;
                }
                if (!word) { const a = atom(); return a ? a.tex : ''; }
                if (word.length === 1) return word;
                if (NAMES.has(word) && NAMES.get(word)) return NAMES.get(word);
                return '\\mathrm{' + word + '}';
            }
            if (tk.t === 'num') {
                pos++;
                let v = tk.v;
                // A trailing charge sign: SO_4^2-, Fe^3+ — but x^2-1 is a minus.
                if (kind === 'sup' && peek() && peek().t === 'sym' && (peek().v === '+' || peek().v === '-')) {
                    const after = peek(1);
                    const ends = !after || after.t === 'space' || after.t === 'close' || after.t === 'op' ||
                        (after.t === 'sym' && /^[+\-=,;:]$/.test(after.v));
                    if (ends) { v += peek().v; pos++; }
                }
                return v;
            }
            if (tk.t === 'sym' && tk.v !== '^' && tk.v !== '_' && tk.v !== '/') {
                pos++;
                return symTex(tk.v);
            }
            const a = atom();
            return a ? a.tex : '';
        }

        // One atom, without scripts. Returns { tex, inner?, num? } or null.
        function atom() {
            const tk = peek();
            if (!tk) return null;
            switch (tk.t) {
                case 'num': pos++; return { tex: tk.v, num: true };
                case 'id': pos++; return { tex: tk.v };
                case 'text': pos++; return { tex: '\\text{' + texText(tk.v) + '}' };
                case 'raw': pos++; return { tex: tk.v };
                case 'cmd': pos++; return { tex: tk.v, op: OP_CMDS.has(tk.v) };
                case 'op': pos++; return { tex: tk.v, op: true };
                case 'open': {
                    const g = group();
                    return { tex: g.tex, inner: g.paren && g.closed ? g.inner : null };
                }
                case 'name': return nameAtom(tk);
                default: return null;
            }
        }

        function nameAtom(tk) {
            const name = tk.v;
            if (ARG_FUNCS.includes(name)) {
                pos++;
                const a = arg();
                return { tex: (name === 'cbrt' ? '\\sqrt[3]{' : '\\sqrt{') + a + '}' };
            }
            if (CALL_FUNCS.includes(name)) {
                if (!tk.call) {
                    // Not a call: plain letters (`1 bar`, `dot`).
                    pos++;
                    return { tex: name.split('').join(' ') };
                }
                pos++;
                if (name === 'binom') {
                    const args = callArgs();
                    return { tex: '\\binom{' + (args[0] || '') + '}{' + (args[1] || '') + '}' };
                }
                if (name === 'root') {
                    const args = callArgs();
                    let x = args[1];
                    if (args.length < 2) {
                        skipSpace();
                        x = arg();
                    }
                    return { tex: '\\sqrt[' + (args[0] || '') + ']{' + (x || '') + '}' };
                }
                const a = arg();
                if (name === 'abs') return { tex: '\\left|' + a + '\\right|' };
                if (name === 'norm') return { tex: '\\left\\|' + a + '\\right\\|' };
                return { tex: ACCENTS[name] + '{' + a + '}' };
            }
            pos++;
            return { tex: NAMES.get(name), op: ['\\times', '\\div', '\\cdot', '\\approx', '\\propto', '\\equiv', '\\bmod', '\\perp', '\\parallel'].includes(NAMES.get(name)) };
        }

        // An atom plus any ^ and _ that follow it.
        function factor() {
            const tk = peek();
            let base;
            if (isSym(tk, '^') || isSym(tk, '_')) base = { tex: '{}' };
            else base = atom();
            if (!base) return null;
            if (base.op) return { kind: 'op', tex: base.tex };
            let sub = null;
            let sup = null;
            for (;;) {
                let k = 0;
                while (peek(k) && peek(k).t === 'space') k++;
                const nx = peek(k);
                if (!(isSym(nx, '^') || isSym(nx, '_'))) break;
                pos += k + 1;
                if (nx.v === '^') {
                    const a = scriptArg('sup');
                    sup = sup === null ? a : sup + '^{' + a + '}';
                } else {
                    const a = scriptArg('sub');
                    sub = sub === null ? a : sub + '_{' + a + '}';
                }
            }
            let tex = base.tex;
            if (sub !== null || sup !== null) {
                if (/^\\(?:left|sqrt|vec|hat|overline|dot|ddot|tilde|binom|text|mathrm)/.test(tex) && !/^\\[A-Za-z]+$/.test(tex)) tex = '{' + tex + '}';
                if (sub !== null) tex += '_{' + sub + '}';
                if (sup !== null) tex += '^{' + sup + '}';
            }
            return { kind: 'f', tex, inner: sub === null && sup === null ? base.inner : null, num: base.num && sub === null && sup === null };
        }

        // A sequence up to `closer` (not consumed). Builds a flat list of
        // factors, operators, spaces and slashes, then folds the slashes.
        function seq(closer, stopAtComma) {
            const items = [];
            while (pos < toks.length) {
                const tk = peek();
                if (tk.t === 'close') {
                    if (tk.v === closer) break;
                    pos++;
                    items.push({ kind: 'op', tex: symTex(tk.v) });
                    continue;
                }
                if (stopAtComma && isSym(tk, ',')) break;
                // Two or more spaces are a visible gap: "F = ma,  p = mv".
                if (tk.t === 'space') { pos++; items.push(tk.n >= 2 ? { kind: 'op', tex: '\\quad' } : { kind: 'sp' }); continue; }
                if (isSym(tk, '/')) { pos++; items.push({ kind: 'slash' }); continue; }
                if (tk.t === 'sym' && tk.v !== '^' && tk.v !== '_') {
                    pos++;
                    if (tk.v === '\'' || tk.v === '!' || tk.v === '.') { items.push({ kind: 'f', tex: tk.v }); continue; }
                    if (tk.v === '*') {
                        // Between two numbers it is ×: 6.02*10^23.
                        const prev = items[items.length - 1];
                        const nx = peek();
                        items.push({ kind: 'op', tex: prev && prev.kind === 'f' && prev.num && nx && nx.t === 'num' ? '\\times' : '\\cdot' });
                        continue;
                    }
                    items.push({ kind: 'op', tex: symTex(tk.v) });
                    continue;
                }
                const f = factor();
                if (f) items.push(f);
                else pos++;
            }
            return fold(items);
        }

        return seq(null, false).replace(/\s+/g, ' ').trim();
    }

    // Folds `/` into \frac. A side is the run of factors touching the slash
    // (spaces right next to the slash are ignored); a side that is exactly one
    // bracketed group loses its brackets.
    function fold(items) {
        const segs = [];
        for (const it of items) {
            const last = segs[segs.length - 1];
            if (it.kind === 'f') {
                if (last && last.kind === 'run') last.parts.push(it);
                else segs.push({ kind: 'run', parts: [it] });
            } else {
                segs.push(it);
            }
        }
        const side = (run) => (run.parts.length === 1 && run.parts[0].inner != null ? run.parts[0].inner : run.parts.map(p => p.tex).join(' '));
        const out = [];
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (seg.kind !== 'slash') { out.push(seg); continue; }
            while (out.length && out[out.length - 1].kind === 'sp') out.pop();
            let j = i + 1;
            while (j < segs.length && segs[j].kind === 'sp') j++;
            const num = out[out.length - 1];
            const den = segs[j];
            if (num && num.kind === 'run' && den && den.kind === 'run') {
                out.pop();
                out.push({ kind: 'run', parts: [{ kind: 'f', tex: '\\frac{' + side(num) + '}{' + side(den) + '}' }] });
                i = j;
            } else {
                out.push({ kind: 'op', tex: '/' });
            }
        }
        return out.map(seg => {
            if (seg.kind === 'run') return seg.parts.map(p => p.tex).join(' ');
            if (seg.kind === 'sp') return '';
            return seg.tex;
        }).filter(Boolean).join(' ');
    }

    // Renders one formula with the KaTeX instance it is given. Returns
    // { html, tex, error }; on a parse error `html` is '' and `error` says why.
    function renderFormula(katex, src) {
        const tex = toTex(src);
        if (!tex) return { html: '', tex: '', error: null };
        if (!katex || typeof katex.renderToString !== 'function') return { html: '', tex, error: 'Maths renderer not loaded' };
        try {
            const html = katex.renderToString('\\displaystyle ' + tex, Object.assign({}, RENDER_OPTIONS, { macros: {} }));
            return { html, tex, error: null };
        } catch (e) {
            const msg = String(e && e.message || e).replace(/^KaTeX parse error:\s*/, '');
            return { html: '', tex, error: msg.length > 140 ? msg.slice(0, 137) + '…' : msg };
        }
    }

    // ── Floating-window geometry ────────────────────────────────────────────

    function clampToArea(bounds, area) {
        const w = Math.max(Math.min(bounds.width, area.width), Math.min(FLOAT_MIN.width, area.width));
        const h = Math.max(Math.min(bounds.height, area.height), Math.min(FLOAT_MIN.height, area.height));
        const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - w);
        const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - h);
        return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
    }

    // A drag of the resize grip: new size from where the drag started, kept
    // between the minimum and the edge of the screen it is on.
    function resizeWithin(bounds, width, height, area) {
        const w = Math.round(clampNum(width, FLOAT_MIN.width, Math.max(FLOAT_MIN.width, area.x + area.width - bounds.x), bounds.width));
        const h = Math.round(clampNum(height, FLOAT_MIN.height, Math.max(FLOAT_MIN.height, area.y + area.height - bounds.y), bounds.height));
        return { x: bounds.x, y: bounds.y, width: w, height: h };
    }

    function cornerPosition(area, dims, corner, margin) {
        const g = Number.isFinite(margin) ? margin : 16;
        const c = CORNERS.includes(corner) ? corner : 'top-right';
        let x, y;
        if (c.endsWith('left')) x = area.x + g;
        else if (c.endsWith('right')) x = area.x + area.width - dims.width - g;
        else x = area.x + (area.width - dims.width) / 2;
        if (c.startsWith('top')) y = area.y + g;
        else if (c.startsWith('bottom')) y = area.y + area.height - dims.height - g;
        else y = area.y + (area.height - dims.height) / 2;
        return { x: Math.round(x), y: Math.round(y) };
    }

    // Moves a window to another display keeping its relative spot.
    function mapToArea(bounds, from, to) {
        const fx = from.width > bounds.width ? (bounds.x - from.x) / (from.width - bounds.width) : 0;
        const fy = from.height > bounds.height ? (bounds.y - from.y) / (from.height - bounds.height) : 0;
        const rx = Math.min(1, Math.max(0, fx));
        const ry = Math.min(1, Math.max(0, fy));
        return clampToArea({
            x: to.x + rx * Math.max(0, to.width - bounds.width),
            y: to.y + ry * Math.max(0, to.height - bounds.height),
            width: bounds.width,
            height: bounds.height
        }, to);
    }

    // ── Starter sheets ──────────────────────────────────────────────────────
    // High-school core (GCSE / A-level / AP / IB) plus a few first-year
    // university extras. Written mostly in the shorthand, so a student who
    // opens one to edit sees the same notation they would type.

    const F = (label, src, note) => ({ kind: 'formula', label, src, note: note || '' });
    const H = (label) => ({ kind: 'heading', label, src: '', note: '' });
    const T = (label) => ({ kind: 'text', label, src: '', note: '' });

    const STARTERS = [
        {
            id: 'algebra', subject: 'Maths', title: 'Algebra & functions', color: '#60a5fa',
            blurb: 'Quadratics, indices, logs, sequences and the binomial expansion.',
            rows: [
                H('Quadratics'),
                F('Quadratic formula', 'x = (-b +- sqrt(b^2 - 4ac))/(2a)'),
                F('Discriminant', 'Delta = b^2 - 4ac', 'Δ > 0: two real roots · Δ = 0: one · Δ < 0: none'),
                F('Completing the square', 'ax^2 + bx + c = a(x + b/(2a))^2 + c - b^2/(4a)'),
                F('Sum and product of roots', 'alpha + beta = -b/a,   alpha beta = c/a'),
                H('Indices & logs'),
                F('Multiplying powers', 'a^m * a^n = a^(m+n)'),
                F('Power of a power', '(a^m)^n = a^(mn)'),
                F('Negative & fractional powers', 'a^-n = 1/a^n,   a^(m/n) = root(n)(a^m)'),
                F('Log definition', 'y = a^x <=> x = log_a y'),
                F('Log laws', 'log_a(xy) = log_a x + log_a y'),
                F('', 'log_a(x/y) = log_a x - log_a y'),
                F('', 'log_a(x^k) = k log_a x'),
                F('Change of base', 'log_a x = (log_b x)/(log_b a)'),
                H('Sequences & series'),
                F('Arithmetic: nth term', 'u_n = a + (n-1)d'),
                F('Arithmetic: sum', 'S_n = n/2 (2a + (n-1)d)'),
                F('Geometric: nth term', 'u_n = ar^(n-1)'),
                F('Geometric: sum', 'S_n = (a(1 - r^n))/(1 - r)'),
                F('Sum to infinity', 'S_oo = a/(1 - r)', 'only when |r| < 1'),
                F('Binomial expansion', '(a + b)^n = sum_(k=0)^n binom(n, k) a^(n-k) b^k'),
                F('Binomial coefficient', 'binom(n, k) = (n!)/(k!(n-k)!)')
            ]
        },
        {
            id: 'trig', subject: 'Maths', title: 'Trigonometry & geometry', color: '#22d3ee',
            blurb: 'SOH CAH TOA, sine and cosine rules, identities, radians and volumes.',
            rows: [
                H('Right-angled triangles'),
                F('Sine', 'sin theta = "opp"/"hyp"'),
                F('Cosine', 'cos theta = "adj"/"hyp"'),
                F('Tangent', 'tan theta = "opp"/"adj"'),
                F('Pythagoras', 'a^2 + b^2 = c^2'),
                H('Any triangle'),
                F('Sine rule', 'a/(sin A) = b/(sin B) = c/(sin C)'),
                F('Cosine rule', 'a^2 = b^2 + c^2 - 2bc cos A'),
                F('Area', '"Area" = 1/2 ab sin C'),
                H('Identities'),
                F('Pythagorean identity', 'sin^2 x + cos^2 x = 1'),
                F('', '1 + tan^2 x = sec^2 x'),
                F('Tangent', 'tan x = (sin x)/(cos x)'),
                F('Double angle', 'sin 2x = 2 sin x cos x'),
                F('', 'cos 2x = cos^2 x - sin^2 x = 1 - 2sin^2 x'),
                F('Compound angle', 'sin(A +- B) = sin A cos B +- cos A sin B'),
                F('', 'cos(A +- B) = cos A cos B -+ sin A sin B'),
                H('Circles & radians'),
                F('Degrees to radians', '180 deg = pi "rad"'),
                F('Arc length', 's = r theta', 'θ in radians'),
                F('Sector area', 'A = 1/2 r^2 theta'),
                F('Circle equation', '(x - a)^2 + (y - b)^2 = r^2', 'centre (a, b), radius r'),
                H('Areas & volumes'),
                F('Sphere', 'V = 4/3 pi r^3,   A = 4 pi r^2'),
                F('Cone', 'V = 1/3 pi r^2 h'),
                F('Cylinder', 'V = pi r^2 h'),
                F('Trapezium', 'A = 1/2 (a + b)h')
            ]
        },
        {
            id: 'derivatives', subject: 'Calculus', title: 'Differentiation', color: '#a78bfa',
            blurb: 'Rules, standard derivatives, stationary points, Taylor series.',
            rows: [
                H('Rules'),
                F('Power rule', 'd/dx (x^n) = nx^(n-1)'),
                F('Product rule', 'd/dx (uv) = u (dv)/(dx) + v (du)/(dx)'),
                F('Quotient rule', 'd/dx (u/v) = (v (du)/(dx) - u (dv)/(dx))/v^2'),
                F('Chain rule', 'dy/dx = dy/du * du/dx'),
                F('From first principles', "f'(x) = lim_(h->0) (f(x+h) - f(x))/h"),
                H('Standard derivatives'),
                F('', 'd/dx sin x = cos x,   d/dx cos x = -sin x'),
                F('', 'd/dx tan x = sec^2 x'),
                F('', 'd/dx e^(kx) = ke^(kx),   d/dx ln x = 1/x'),
                F('', 'd/dx a^x = a^x ln a'),
                F('', 'd/dx arcsin x = 1/sqrt(1 - x^2),   d/dx arctan x = 1/(1 + x^2)', 'university'),
                H('Stationary points'),
                F('Stationary point', 'dy/dx = 0'),
                F('Nature', '(d^2y)/(dx^2) > 0 => "minimum",   (d^2y)/(dx^2) < 0 => "maximum"'),
                F('Tangent line', 'y - y_1 = m(x - x_1)', "m = f'(x₁)"),
                H('Series & approximation'),
                F('Taylor series', 'f(x) = sum_(n=0)^oo (f^((n))(a))/(n!) (x - a)^n', 'university'),
                F('Newton–Raphson', "x_(n+1) = x_n - f(x_n)/(f'(x_n))"),
                F('Partial derivative', '(partial f)/(partial x)', 'differentiate in x, holding the other variables fixed')
            ]
        },
        {
            id: 'integrals', subject: 'Calculus', title: 'Integration & series', color: '#f472b6',
            blurb: 'Standard integrals, by parts, areas, volumes and power series.',
            rows: [
                H('Standard integrals'),
                F('Power', 'int x^n dx = x^(n+1)/(n+1) + C', 'n ≠ −1'),
                F('Reciprocal', 'int 1/x dx = ln|x| + C'),
                F('Exponential', 'int e^(kx) dx = 1/k e^(kx) + C'),
                F('Trig', 'int sin x dx = -cos x + C,   int cos x dx = sin x + C'),
                F('', 'int sec^2 x dx = tan x + C'),
                F('', 'int 1/(a^2 + x^2) dx = 1/a arctan(x/a) + C', 'university'),
                F('', 'int 1/sqrt(a^2 - x^2) dx = arcsin(x/a) + C', 'university'),
                H('Techniques'),
                F('By parts', 'int u (dv)/(dx) dx = uv - int v (du)/(dx) dx'),
                F('By substitution', 'int f(g(x)) g\'(x) dx = int f(u) du'),
                F('Definite integral', 'int_a^b f(x) dx = F(b) - F(a)'),
                H('Areas & volumes'),
                F('Area under a curve', 'A = int_a^b y dx'),
                F('Area between curves', 'A = int_a^b (f(x) - g(x)) dx'),
                F('Volume of revolution', 'V = pi int_a^b y^2 dx'),
                H('Power series'),
                F('Exponential', 'e^x = sum_(n=0)^oo x^n/(n!) = 1 + x + x^2/(2!) + ...'),
                F('Sine', 'sin x = x - x^3/(3!) + x^5/(5!) - ...'),
                F('Cosine', 'cos x = 1 - x^2/(2!) + x^4/(4!) - ...'),
                F('Log', 'ln(1 + x) = x - x^2/2 + x^3/3 - ...', '−1 < x ≤ 1'),
                F('Euler\'s formula', 'e^(i theta) = cos theta + i sin theta', 'university')
            ]
        },
        {
            id: 'mechanics', subject: 'Physics', title: 'Mechanics', color: '#34d399',
            blurb: 'SUVAT, Newton\'s laws, momentum, circular motion and gravity.',
            rows: [
                H('Kinematics (SUVAT)'),
                F('', 'v = u + at'),
                F('', 's = ut + 1/2 at^2'),
                F('', 'v^2 = u^2 + 2as'),
                F('', 's = 1/2 (u + v)t'),
                F('', 's = vt - 1/2 at^2'),
                F('Projectile range', 'R = (u^2 sin 2theta)/g'),
                H('Forces & momentum'),
                F('Newton\'s second law', 'F = ma'),
                F('Weight', 'W = mg'),
                F('Friction', 'F <= mu R'),
                F('Momentum', 'p = mv'),
                F('Impulse', 'F Delta t = Delta p'),
                F('Moment', 'M = Fd'),
                F('Pressure', 'p = F/A'),
                H('Circular motion & gravity'),
                F('Angular speed', 'omega = v/r = 2pi f'),
                F('Centripetal acceleration', 'a = v^2/r = omega^2 r'),
                F('Centripetal force', 'F = mv^2/r'),
                F('Newton\'s gravitation', 'F = GMm/r^2'),
                F('Field strength', 'g = GM/r^2'),
                F('Simple harmonic motion', 'a = -omega^2 x,   T = 2pi sqrt(l/g)', 'pendulum: small angles'),
                H('Constants'),
                F('', 'g = 9.81 "m s"^-2'),
                F('', 'G = 6.67*10^-11 "N m"^2 "kg"^-2')
            ]
        },
        {
            id: 'physics2', subject: 'Physics', title: 'Energy, waves & electricity', color: '#fbbf24',
            blurb: 'Energy and power, waves and light, circuits and fields.',
            rows: [
                H('Energy & power'),
                F('Kinetic energy', 'E_k = 1/2 mv^2'),
                F('Gravitational PE', 'E_p = mgh'),
                F('Work done', 'W = Fs cos theta'),
                F('Power', 'P = W/t = Fv'),
                F('Efficiency', 'eta = "useful output"/"total input" * 100%'),
                F('Hooke\'s law', 'F = kx,   E = 1/2 kx^2'),
                F('Specific heat capacity', 'Q = mc Delta T'),
                H('Waves'),
                F('Wave equation', 'v = f lambda'),
                F('Period', 'T = 1/f'),
                F('Snell\'s law', 'n_1 sin theta_1 = n_2 sin theta_2'),
                F('Refractive index', 'n = c/v'),
                F('Photon energy', 'E = hf = hc/lambda'),
                F('Double slit', 'lambda = ax/D'),
                H('Electricity'),
                F('Ohm\'s law', 'V = IR'),
                F('Power', 'P = IV = I^2 R = V^2/R'),
                F('Charge', 'Q = It'),
                F('Energy transferred', 'W = QV'),
                F('Resistors in series', 'R_T = R_1 + R_2 + ...'),
                F('Resistors in parallel', '1/R_T = 1/R_1 + 1/R_2 + ...'),
                F('Resistivity', 'R = (rho L)/A'),
                F('Capacitance', 'C = Q/V,   E = 1/2 QV'),
                F('Coulomb\'s law', 'F = (q_1 q_2)/(4 pi epsilon_0 r^2)', 'university'),
                H('Constants'),
                F('', 'c = 3.00*10^8 "m s"^-1'),
                F('', 'h = 6.63*10^-34 "J s"'),
                F('', 'e = 1.60*10^-19 "C"')
            ]
        },
        {
            id: 'moles', subject: 'Chemistry', title: 'Moles, gases & reactions', color: '#a3e635',
            blurb: 'Amount of substance, concentration, yields and the gas laws.',
            rows: [
                H('Amount of substance'),
                F('Moles from mass', 'n = m/M', 'n in mol, m in g, M in g mol⁻¹'),
                F('Concentration', 'c = n/V', 'V in dm³'),
                F('Number of particles', 'N = n N_"A"'),
                F('Avogadro constant', 'N_"A" = 6.022*10^23 "mol"^-1'),
                F('Percentage yield', '"% yield" = "actual yield"/"theoretical yield" * 100'),
                F('Atom economy', '"atom economy" = ("M"_"r" " of desired product")/("total " "M"_"r" " of reactants") * 100'),
                H('Gases'),
                F('Ideal gas equation', 'pV = nRT', 'R = 8.31 J K⁻¹ mol⁻¹, T in kelvin'),
                F('Combined gas law', 'p_1V_1/T_1 = p_2V_2/T_2'),
                F('Molar gas volume', 'V = n * 24 "dm"^3', 'at room temperature and pressure'),
                F('Kelvin', 'T("K") = theta(deg"C") + 273'),
                H('Reactions'),
                F('Combustion of hydrogen', 'ce(2H2 + O2 -> 2H2O)'),
                F('Neutralisation', 'ce(H+ + OH- -> H2O)'),
                F('Acid + carbonate', 'ce(2HCl + CaCO3 -> CaCl2 + H2O + CO2)'),
                F('Haber process', 'ce(N2 + 3H2 <=> 2NH3)')
            ]
        },
        {
            id: 'equilibria', subject: 'Chemistry', title: 'Rates, equilibrium & acids', color: '#f87171',
            blurb: 'Rate equations, Arrhenius, Kc and Kp, Gibbs energy and pH.',
            rows: [
                H('Rates'),
                F('Rate equation', '"rate" = k[A]^m[B]^n'),
                F('Arrhenius equation', 'k = Ae^(-E_a/(RT))'),
                F('', 'ln k = ln A - E_a/(RT)'),
                F('First-order half-life', 't_(1/2) = (ln 2)/k'),
                H('Equilibrium'),
                F('', 'ce(aA + bB <=> cC + dD)'),
                F('Equilibrium constant', 'K_c = ([C]^c[D]^d)/([A]^a[B]^b)'),
                F('In partial pressures', 'K_p = (p_C^c p_D^d)/(p_A^a p_B^b)'),
                F('Gibbs free energy', 'Delta G = Delta H - T Delta S', 'feasible when ΔG ≤ 0'),
                F('', 'Delta G^circ = -RT ln K', 'university'),
                H('Acids & bases'),
                F('pH', '"pH" = -log_10[H^+]'),
                F('', '[H^+] = 10^(-"pH")'),
                F('Ionic product of water', 'K_w = [H^+][OH^-] = 1.0*10^-14', 'at 298 K'),
                F('Acid dissociation constant', 'K_a = ([H^+][A^-])/([HA])'),
                F('', '"p"K_a = -log_10 K_a'),
                F('Buffer (Henderson–Hasselbalch)', '"pH" = "p"K_a + log_10 ([A^-])/([HA])'),
                H('Electrochemistry'),
                F('Cell potential', 'E_"cell" = E_"right" - E_"left"'),
                F('Nernst equation', 'E = E^circ - (RT)/(nF) ln Q', 'university'),
                F('', 'Delta G^circ = -nFE^circ_"cell"')
            ]
        }
    ];

    // The shorthand at a glance, shown in the panel's help.
    const CHEATSHEET = [
        ['a/b', 'fraction'], ['(a+b)/(2c)', 'brackets group a side'], ['x^2  x^(n+1)', 'power'],
        ['x_1  v_max', 'subscript'], ['sqrt(x)  root(3)(x)', 'roots'], ['+-  <=  >=  !=  ~=', '± ≤ ≥ ≠ ≈'],
        ['->  =>  <=>', '→ ⇒ ⇔'], ['pi  theta  Delta', 'Greek letters'], ['oo  deg', '∞ °'],
        ['sin x  ln x  log_a x', 'functions'], ['sum_(i=1)^n  int_a^b', 'sum, integral'], ['lim_(x->0)', 'limit'],
        ['abs(x)  vec(F)  bar(x)', '|x|, vector, mean'], ['"text"', 'words'], ['ce(H2O + CO2)', 'chemistry'],
        ['\\frac{a}{b}', 'LaTeX works too']
    ];

    // Insert buttons for the editor. `|` marks where the caret lands.
    const PALETTE = [
        { group: 'Structure', items: [
            { tex: '\\frac{a}{b}', ins: '(|)/()', title: 'Fraction' },
            { tex: 'x^{n}', ins: '^(|)', title: 'Power' },
            { tex: 'x_{n}', ins: '_|', title: 'Subscript' },
            { tex: '\\sqrt{x}', ins: 'sqrt(|)', title: 'Square root' },
            { tex: '\\sqrt[n]{x}', ins: 'root(|)()', title: 'nth root' },
            { tex: '|x|', ins: 'abs(|)', title: 'Absolute value' },
            { tex: '\\vec{v}', ins: 'vec(|)', title: 'Vector' },
            { tex: '\\textstyle\\sum', ins: 'sum_(|)^()', title: 'Sum' },
            { tex: '\\textstyle\\int', ins: 'int_(|)^() ', title: 'Integral' },
            { tex: '\\lim', ins: 'lim_(|->)', title: 'Limit' },
            { tex: '\\frac{d}{dx}', ins: 'd/dx |', title: 'Derivative' },
            { tex: '\\text{Aa}', ins: '"|"', title: 'Text' },
            { tex: '\\ce{H2O}', ins: 'ce(|)', title: 'Chemical equation' }
        ] },
        { group: 'Symbols', items: [
            { tex: '\\pm', ins: '+-' }, { tex: '\\times', ins: ' times ' }, { tex: '\\cdot', ins: '*' },
            { tex: '\\le', ins: '<=' }, { tex: '\\ge', ins: '>=' }, { tex: '\\ne', ins: '!=' },
            { tex: '\\approx', ins: '~=' }, { tex: '\\propto', ins: ' propto ' }, { tex: '\\to', ins: '->' },
            { tex: '\\Rightarrow', ins: '=>' }, { tex: '\\infty', ins: 'oo' }, { tex: '\\degree', ins: 'deg' },
            { tex: '\\partial', ins: 'partial' }, { tex: '\\nabla', ins: 'nabla' }, { tex: '\\hbar', ins: 'hbar' }
        ] },
        { group: 'Greek', items: ['alpha', 'beta', 'gamma', 'delta', 'Delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho', 'sigma', 'Sigma', 'tau', 'phi', 'omega', 'Omega']
            .map(g => ({ tex: '\\' + g, ins: g })) }
    ];

    return {
        STORE_VERSION, MAX_SHEETS, MAX_ROWS, MAX_SRC, MAX_LABEL, MAX_NOTE, MAX_TITLE, MAX_SUBJECT, MAX_FLOATS,
        ROW_KINDS, SUBJECTS, COLORS, STYLES, SCALE_MIN, SCALE_MAX, OPACITY_MIN, FLOAT_MIN, FLOAT_DEFAULT, CORNERS,
        DEFAULT_SETTINGS, RENDER_OPTIONS, STARTERS, CHEATSHEET, PALETTE,
        cleanText, cleanSrc, cleanId, cleanColor, cleanAccel, newId, roundScale,
        sanitizeRow, sanitizeRows, sanitizeSheet, sanitizeFloat, sanitizeStore, mergeSettings,
        countFormulas, sheetFromStarter, matchesQuery, groupBySubject,
        tokenize, toTex, renderFormula,
        clampToArea, resizeWithin, cornerPosition, mapToArea
    };
});
