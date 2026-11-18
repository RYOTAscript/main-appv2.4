// ── Floating formula sheet ──
// The page inside each popped-out sheet (study-float.html). Everything it
// knows arrives from main over window.studyFloat (study-float-preload.js);
// everything it does goes back the same way. It never names a sheet id.
//
// Idle-cheap on purpose — this window can sit on top of a game for hours.
// Nothing here runs on a timer or an animation loop: the sheet is drawn when
// main sends it, and a change of look (style, text size, labels) only flips
// classes. Formulas are typeset once and cached by source, so dragging the
// opacity or text size never re-runs KaTeX.
//
// User text (title, labels, notes, headings) only ever goes in through
// textContent. Formulas go in as KaTeX's own HTML, rendered with
// StudyEngine.RENDER_OPTIONS (trust: false) — KaTeX escapes every character of
// the input it puts in that HTML.

(function () {
    'use strict';

    const E = window.StudyEngine;
    const api = window.studyFloat;
    if (!E || !api) return;

    const $ = (id) => document.getElementById(id);
    const root = $('sf');
    const els = {
        title: $('sf-title'), subject: $('sf-subject'), body: $('sf-body'), scroll: $('sf-scroll'),
        smaller: $('sf-smaller'), bigger: $('sf-bigger'), ghost: $('sf-ghost'), more: $('sf-more'),
        close: $('sf-close'), grip: $('sf-grip'), unghost: $('sf-unghost')
    };

    const CACHE_MAX = 400;
    const cache = new Map(); // formula source -> { html, error }
    let state = null;
    let sheetSig = '';
    let overHandle = false;

    function typeset(src) {
        if (cache.has(src)) return cache.get(src);
        const out = E.renderFormula(window.katex, src);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(src, out);
        return out;
    }

    function rowEl(row) {
        const div = document.createElement('div');
        if (row.kind === 'heading') {
            div.className = 'row h';
            div.textContent = row.label;
            return div;
        }
        if (row.kind === 'text') {
            div.className = 'row t';
            div.textContent = row.label;
            return div;
        }
        div.className = 'row f';
        if (row.label) {
            const lab = document.createElement('div');
            lab.className = 'lab';
            lab.textContent = row.label;
            div.appendChild(lab);
        }
        const math = document.createElement('div');
        math.className = 'math';
        const out = typeset(row.src);
        if (out.html) {
            math.innerHTML = out.html;
        } else if (row.src) {
            math.classList.add('bad');
            math.textContent = row.src;
            math.title = out.error || '';
        }
        div.appendChild(math);
        if (row.note) {
            const note = document.createElement('div');
            note.className = 'note';
            note.textContent = row.note;
            div.appendChild(note);
        }
        return div;
    }

    function paintSheet(sheet) {
        const frag = document.createDocumentFragment();
        const rows = sheet.rows.filter(r => r.kind !== 'formula' || r.src || r.label);
        for (const row of rows) frag.appendChild(rowEl(row));
        if (!rows.length) {
            const p = document.createElement('div');
            p.className = 'empty';
            p.textContent = 'This sheet is empty. Right-click and choose "Edit this sheet in main" to add formulas.';
            frag.appendChild(p);
        }
        els.body.textContent = '';
        els.body.appendChild(frag);
    }

    function apply(payload) {
        if (!payload || !payload.sheet) return;
        state = payload;
        const { sheet, prefs } = payload;
        const keep = ['near', 'resizing'].filter(c => root.classList.contains(c));
        root.className = ['sf', 'style-' + prefs.style, prefs.ghost ? 'ghost' : '', prefs.labels ? '' : 'hide-labels', prefs.notes ? '' : 'hide-notes']
            .concat(keep).filter(Boolean).join(' ');
        root.style.setProperty('--c', sheet.color);
        root.style.setProperty('--s', String(prefs.scale));
        els.title.textContent = sheet.title;
        els.subject.textContent = sheet.subject;
        document.title = sheet.title;
        // Re-typeset only when the sheet's content actually changed.
        const sig = sheet.id + '|' + sheet.updatedAt + '|' + sheet.rows.length;
        if (sig !== sheetSig) {
            sheetSig = sig;
            paintSheet(sheet);
        }
        if (!prefs.ghost && overHandle) overHandle = false;
    }

    els.smaller.addEventListener('click', () => api.zoom(-1));
    els.bigger.addEventListener('click', () => api.zoom(1));
    els.ghost.addEventListener('click', () => api.ghost());
    els.more.addEventListener('click', () => api.menu());
    els.close.addEventListener('click', () => api.close());
    els.unghost.addEventListener('click', () => api.exitGhost());
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); api.menu(); });
    document.addEventListener('dblclick', (e) => { if (e.target.closest && e.target.closest('.head')) api.openApp(); });

    // Ctrl + wheel changes the text size, like a browser zoom.
    document.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        api.zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (e.altKey || e.metaKey) return;
        const k = e.key;
        if (k === '+' || k === '=') { e.preventDefault(); api.zoom(1); }
        else if (k === '-' || k === '_') { e.preventDefault(); api.zoom(-1); }
        else if (k === '0' && e.ctrlKey) { e.preventDefault(); api.zoom(0); }
        else if (k === 'Escape') api.close();
    });

    // Resize grip. A frameless transparent window has no native resize border
    // on Windows, so the page measures the drag in screen coordinates and asks
    // main for a size; main clamps it to the screen. One request per frame.
    els.grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !state || state.prefs.ghost) return;
        e.preventDefault();
        try { els.grip.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
        root.classList.add('resizing');
        const start = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
        let want = null;
        let frame = 0;
        const send = () => { frame = 0; if (want) api.resizeTo(want[0], want[1]); };
        const move = (ev) => {
            want = [start.w + ev.screenX - start.x, start.h + ev.screenY - start.y];
            if (!frame) frame = requestAnimationFrame(send);
        };
        const end = () => {
            els.grip.removeEventListener('pointermove', move);
            els.grip.removeEventListener('pointerup', end);
            els.grip.removeEventListener('pointercancel', end);
            if (frame) cancelAnimationFrame(frame);
            send();
            root.classList.remove('resizing');
            api.resizeEnd();
        };
        els.grip.addEventListener('pointermove', move);
        els.grip.addEventListener('pointerup', end);
        els.grip.addEventListener('pointercancel', end);
    });

    // Ghost mode: the window lets clicks fall through to whatever is under it,
    // but still receives mouse MOVES. Ask main to catch clicks only while the
    // pointer is over the unlock handle.
    document.addEventListener('mousemove', (e) => {
        if (!state || !state.prefs.ghost) return;
        root.classList.add('near');
        const r = els.unghost.getBoundingClientRect();
        const over = e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
        if (over !== overHandle) {
            overHandle = over;
            api.hoverHandle(over);
        }
    });
    document.addEventListener('mouseleave', () => {
        root.classList.remove('near');
        if (overHandle) { overHandle = false; api.hoverHandle(false); }
    });

    api.onState(apply);
    api.ready().then(apply).catch(() => { /* main will push state */ });
})();
