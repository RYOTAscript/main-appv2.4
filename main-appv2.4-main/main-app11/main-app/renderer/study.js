        // ── Study mini widget (renderer UI) ──
        // Formula sheets that float on screen. The main process owns the sheets
        // and the floating always-on-top overlays (main/study.js); every rule —
        // what a sheet may hold, the shorthand → LaTeX converter — lives in
        // renderer/study-engine.js, shared with main and the overlays. THIS file
        // is only UI: the library panel (sheets, editor, starter sheets,
        // settings), built from the state main broadcasts.
        //
        // The DOM is built with createElement and every piece of user text goes
        // in through textContent; there are no inline handlers — one delegated
        // listener per event type on the panel root reads data-act / data-field.
        // The one innerHTML sink is KaTeX's own output (sdMath), rendered with
        // StudyEngine.RENDER_OPTIONS (trust: false), which escapes the input.
        //
        // KaTeX (~300 KB) is loaded on first use of the panel, not at app start
        // (sdLoadKatex) — most launches never open this panel.

        const StE = window.StudyEngine;
        const SD_TABS = [
            { id: 'sheets', label: 'My sheets', icon: 'fa-layer-group' },
            { id: 'starters', label: 'Starter sheets', icon: 'fa-book-open' },
            { id: 'settings', label: 'Settings', icon: 'fa-sliders' }
        ];
        const SD_STYLES = [{ id: 'glass', label: 'Glass' }, { id: 'paper', label: 'Paper' }, { id: 'clear', label: 'Text only' }];
        const SD_KATEX = {
            css: 'styles/vendor/katex/katex.min.css',
            js: 'styles/vendor/katex/katex.min.js',
            chem: 'styles/vendor/katex/contrib/mhchem.min.js'
        };

        let sdState = null;
        let sdSubscribed = false;
        let sdLoading = false;
        let sdTab = (() => {
            try {
                const t = localStorage.getItem('studyTab');
                return SD_TABS.some(x => x.id === t) ? t : 'sheets';
            } catch (e) { return 'sheets'; }
        })();
        let sdEditId = null;        // sheet open in the editor
        let sdDraft = null;         // the editor's working copy of that sheet
        let sdOpenRow = null;       // row expanded for editing
        let sdSaveTimer = null;
        let sdQuery = '';
        let sdPreviewStarter = null;
        let sdConfirmDelete = null; // sheet id whose delete button is armed
        let sdPalette = false;
        let sdBinding = null;       // settings key being bound to a hotkey
        let sdKatexPromise = null;
        const sdCache = new Map();  // formula source -> { html, tex, error }

        function isStudyEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.study;
        }

        async function sdCall(method, ...args) {
            const fn = window.electronAPI && window.electronAPI[method];
            if (typeof fn !== 'function') return { ok: false, error: 'Study isn’t available' };
            try {
                const res = await fn(...args);
                if (res && res.ok === false && res.error && typeof showToast === 'function') showToast(res.error, true);
                return res;
            } catch (e) {
                console.warn('[study]', method, e);
                return { ok: false };
            }
        }

        // ── KaTeX, on demand ──────────────────────────────────────────────────

        function sdLoadKatex() {
            if (sdKatexPromise) return sdKatexPromise;
            const load = (src) => new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = resolve;
                s.onerror = () => reject(new Error('failed to load ' + src));
                document.head.appendChild(s);
            });
            sdKatexPromise = (async () => {
                if (!document.querySelector(`link[href="${SD_KATEX.css}"]`)) {
                    const css = document.createElement('link');
                    css.rel = 'stylesheet';
                    css.href = SD_KATEX.css;
                    document.head.appendChild(css);
                }
                try {
                    if (!window.katex) await load(SD_KATEX.js);
                    await load(SD_KATEX.chem);
                    sdCache.clear();
                    return true;
                } catch (e) {
                    console.error('[study] KaTeX failed to load', e);
                    return false;
                }
            })();
            return sdKatexPromise;
        }

        function sdTypeset(src) {
            if (!window.katex) return { html: '', tex: StE.toTex(src), error: null, pending: true };
            if (sdCache.has(src)) return sdCache.get(src);
            const out = StE.renderFormula(window.katex, src);
            if (sdCache.size > 600) sdCache.delete(sdCache.keys().next().value);
            sdCache.set(src, out);
            return out;
        }

        // ── Tiny DOM helpers ──────────────────────────────────────────────────

        function sdH(tag, props, ...kids) {
            const el = document.createElement(tag);
            if (props) {
                for (const k of Object.keys(props)) {
                    const v = props[k];
                    if (v === null || v === undefined || v === false) continue;
                    if (k === 'class') el.className = v;
                    else if (k === 'text') el.textContent = v;
                    else if (k === 'value') el.value = v;
                    else if (k === 'checked') el.checked = !!v;
                    else el.setAttribute(k, v === true ? '' : String(v));
                }
            }
            for (const kid of kids.flat(3)) {
                if (kid === null || kid === undefined || kid === false) continue;
                el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
            }
            return el;
        }

        function sdIcon(name) { return sdH('i', { class: 'fas ' + name, 'aria-hidden': 'true' }); }

        function sdBtn(act, label, opts) {
            const o = opts || {};
            return sdH('button', Object.assign({ type: 'button', class: 'sd-btn ' + (o.cls || ''), 'data-act': act, title: o.title || null }, o.data || {}),
                o.icon ? sdIcon(o.icon) : null, label ? sdH('span', { text: label }) : null);
        }

        function sdIconBtn(act, icon, title, data, cls) {
            return sdH('button', Object.assign({ type: 'button', class: 'sd-icon ' + (cls || ''), 'data-act': act, title, 'aria-label': title }, data || {}), sdIcon(icon));
        }

        // A typeset formula. KaTeX's HTML is the only thing ever assigned to
        // innerHTML in this file; if it can't be typeset, the source is shown
        // as text instead.
        function sdMath(src, cls) {
            const div = sdH('div', { class: 'sd-math ' + (cls || '') });
            const out = sdTypeset(src);
            if (out.html) div.innerHTML = out.html;
            else {
                div.classList.add(out.pending ? 'pending' : 'bad');
                div.textContent = src;
                if (out.error) div.title = out.error;
            }
            return div;
        }

        function sdSheet(id) { return sdState && sdState.sheets.find(s => s.id === id) || null; }
        // The sheet editor is on screen (it keeps its draft while you look at
        // another tab, but only blocks re-renders while it's actually showing).
        function sdEditing() { return !!(sdEditId && sdDraft && sdTab === 'sheets'); }
        function sdIsOpen(id) { return !!(sdState && sdState.openFloats.includes(id)); }
        function sdPlural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

        // ── State ─────────────────────────────────────────────────────────────

        function sdSetState(s) {
            if (!s || !Array.isArray(s.sheets)) return;
            sdState = s;
            if (sdEditId && !sdSheet(sdEditId)) {
                // Deleted from somewhere else while open in the editor.
                sdEditId = null;
                sdDraft = null;
                sdOpenRow = null;
            }
            // The editor holds the authoritative working copy while it's open;
            // only its "on screen" button needs to follow main.
            if (sdEditing()) {
                sdSyncFloatButton();
                return;
            }
            sdRender();
        }

        async function sdRefresh() {
            if (sdLoading) return;
            sdLoading = true;
            const s = await sdCall('studyGet');
            sdLoading = false;
            if (s && Array.isArray(s.sheets)) sdSetState(s);
            else {
                const panel = document.getElementById('study-panel');
                if (panel) panel.replaceChildren(sdH('p', { class: 'sd-muted', text: 'Study couldn’t load — try toggling the widget off and on.' }));
            }
        }

        function sdSubscribe() {
            if (sdSubscribed || !window.electronAPI) return;
            sdSubscribed = true;
            if (window.electronAPI.onStudyChanged) window.electronAPI.onStudyChanged(sdSetState);
            if (window.electronAPI.onStudyOpen) window.electronAPI.onStudyOpen(sdOnOpen);
        }

        // "Edit this sheet in main" from an overlay.
        function sdOnOpen(p) {
            const id = p && p.sheetId;
            sdTab = 'sheets';
            if (id && sdSheet(id)) sdStartEdit(id, false);
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('study');
            else renderStudyPanel();
        }

        // ── Rendering ─────────────────────────────────────────────────────────

        function renderStudyPanel() {
            const panel = document.getElementById('study-panel');
            if (!panel) return;
            if (!isStudyEnabled()) { panel.replaceChildren(); return; }
            if (!StE) { panel.replaceChildren(sdH('p', { class: 'sd-muted', text: 'Study failed to load.' })); return; }
            sdSubscribe();
            if (!window.katex) sdLoadKatex().then(ok => { if (ok) sdRender(true); });
            if (!sdState) {
                panel.replaceChildren(sdH('div', { class: 'sd' }, sdH('p', { class: 'sd-muted', text: 'Loading your sheets…' })));
                sdRefresh();
                return;
            }
            sdRender(true);
        }

        // Rebuilds the panel. A focused text box survives the rebuild: its
        // value, caret and focus are put straight back, so typing is never
        // interrupted by a state update.
        function sdRender(force) {
            const panel = document.getElementById('study-panel');
            if (!panel || !sdState || !isStudyEnabled()) return;
            if (!force && sdEditing()) return;
            const active = document.activeElement;
            let snap = null;
            if (active && panel.contains(active) && active.dataset && active.dataset.field && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
                snap = { field: active.dataset.field, row: active.dataset.row || '', value: active.value, start: active.selectionStart, end: active.selectionEnd };
            }
            const scroller = panel.closest('.overflow-y-auto') || panel.parentElement;
            const scrollTop = scroller ? scroller.scrollTop : 0;
            const root = sdH('div', { class: 'sd' }, sdTabsEl(), sdBodyEl());
            sdWire(root);
            panel.replaceChildren(root);
            if (scroller) scroller.scrollTop = scrollTop;
            if (snap) {
                const sel = `[data-field="${snap.field}"]` + (snap.row ? `[data-row="${snap.row}"]` : '');
                const again = root.querySelector(sel);
                if (again) {
                    again.value = snap.value;
                    again.focus();
                    try { again.setSelectionRange(snap.start, snap.end); } catch (e) { /* not a text box */ }
                }
            }
        }

        function sdTabsEl() {
            const count = sdState.sheets.length;
            return sdH('div', { class: 'sd-tabs', role: 'tablist' }, SD_TABS.map(t =>
                sdH('button', { type: 'button', role: 'tab', class: 'sd-tab' + (sdTab === t.id ? ' active' : ''), 'data-act': 'tab', 'data-id': t.id, 'aria-selected': sdTab === t.id ? 'true' : 'false' },
                    sdIcon(t.icon), sdH('span', { text: t.label }),
                    t.id === 'sheets' && count ? sdH('span', { class: 'sd-badge', text: String(count) }) : null)));
        }

        function sdBodyEl() {
            if (sdTab === 'starters') return sdStartersEl();
            if (sdTab === 'settings') return sdSettingsEl();
            if (sdEditId && sdDraft) return sdEditorEl();
            return sdSheetsEl();
        }

        function sdHiddenBanner() {
            if (!sdState.hidden) return null;
            return sdH('div', { class: 'sd-banner' }, sdIcon('fa-eye-slash'),
                sdH('span', { text: 'Your formula overlays are hidden.' }),
                sdBtn('toggle-overlays', 'Show them', { cls: 'sd-btn-sm' }));
        }

        // ── My sheets ─────────────────────────────────────────────────────────

        function sdSheetsEl() {
            const sheets = sdState.sheets;
            const wrap = sdH('div', { class: 'sd-view' });
            wrap.appendChild(sdHiddenBanner() || document.createTextNode(''));
            if (!sheets.length) {
                wrap.appendChild(sdH('div', { class: 'sd-empty' },
                    sdH('div', { class: 'sd-empty-icon' }, sdIcon('fa-square-root-variable')),
                    sdH('p', { class: 'sd-empty-title', text: 'No formula sheets yet' }),
                    sdH('p', { class: 'sd-muted', text: 'Start from a ready-made sheet and make it yours, or build one from scratch.' }),
                    sdH('div', { class: 'sd-chips' }, StE.STARTERS.map(st => {
                        const b = sdH('button', { type: 'button', class: 'sd-chip', 'data-act': 'add-starter', 'data-id': st.id, title: st.blurb },
                            sdH('span', { class: 'sd-dot' }), sdH('span', { text: st.title }));
                        b.style.setProperty('--c', st.color);
                        return b;
                    })),
                    sdH('div', { class: 'sd-row' },
                        sdBtn('new', 'New blank sheet', { icon: 'fa-plus', cls: 'sd-btn-primary' }),
                        sdBtn('import', 'Import…', { icon: 'fa-file-import' }))));
                return wrap;
            }
            wrap.appendChild(sdH('div', { class: 'sd-toolbar' },
                sdH('div', { class: 'sd-search' }, sdIcon('fa-magnifying-glass'),
                    sdH('input', { type: 'text', class: 'sd-input', placeholder: 'Search sheets and formulas', 'data-field': 'query', value: sdQuery, spellcheck: 'false' })),
                sdBtn('new', 'New sheet', { icon: 'fa-plus', cls: 'sd-btn-primary' }),
                sdState.openFloats.length ? sdBtn('toggle-overlays', sdState.hidden ? 'Show' : 'Hide', { icon: sdState.hidden ? 'fa-eye' : 'fa-eye-slash', title: 'Show or hide every formula overlay' }) : null));
            const shown = sheets.filter(s => StE.matchesQuery(s, sdQuery));
            if (!shown.length) {
                wrap.appendChild(sdH('p', { class: 'sd-muted sd-pad', text: 'Nothing matches “' + sdQuery.trim() + '”.' }));
                return wrap;
            }
            for (const g of StE.groupBySubject(shown)) {
                wrap.appendChild(sdH('div', { class: 'sd-group' },
                    sdH('div', { class: 'sd-group-title' }, sdH('span', { text: g.subject }), sdH('small', { text: String(g.sheets.length) })),
                    g.sheets.map(sdSheetCard)));
            }
            return wrap;
        }

        function sdSheetCard(sheet) {
            const open = sdIsOpen(sheet.id);
            const n = StE.countFormulas(sheet);
            const first = sheet.rows.find(r => r.kind === 'formula' && r.src);
            const armed = sdConfirmDelete === sheet.id;
            const card = sdH('div', { class: 'sd-card' + (open ? ' on' : '') },
                sdH('div', { class: 'sd-card-main', 'data-act': 'edit', 'data-id': sheet.id, title: 'Edit this sheet' },
                    sdH('div', { class: 'sd-card-title' }, sdH('span', { class: 'sd-dot' }), sdH('span', { class: 'sd-ellipsis', text: sheet.title })),
                    sdH('div', { class: 'sd-card-meta', text: sdPlural(n, 'formula') + (open ? (sdState.hidden ? ' · hidden' : ' · on screen') : '') }),
                    first ? sdMath(first.src, 'sd-mini') : null),
                sdH('div', { class: 'sd-card-actions' },
                    sdBtn('float', open ? 'On screen' : 'Pop out', { icon: open ? 'fa-check' : 'fa-up-right-from-square', cls: 'sd-btn-sm' + (open ? ' sd-btn-on' : ' sd-btn-accent'), data: { 'data-id': sheet.id }, title: open ? 'Close the overlay' : 'Float this sheet on top of everything' }),
                    sdIconBtn('edit', 'fa-pen', 'Edit', { 'data-id': sheet.id }),
                    sdIconBtn('dup', 'fa-copy', 'Duplicate', { 'data-id': sheet.id }),
                    sdIconBtn('export-one', 'fa-file-export', 'Export to a file', { 'data-id': sheet.id }),
                    armed
                        ? sdBtn('del', 'Delete?', { cls: 'sd-btn-sm sd-btn-danger', data: { 'data-id': sheet.id }, title: 'Click again to delete' })
                        : sdIconBtn('del', 'fa-trash-can', 'Delete', { 'data-id': sheet.id }, 'sd-icon-danger')));
            card.style.setProperty('--c', sheet.color);
            return card;
        }

        // ── Editor ────────────────────────────────────────────────────────────

        function sdStartEdit(id, render) {
            const s = sdSheet(id);
            if (!s) return;
            sdFlushSave();
            sdEditId = id;
            sdDraft = { title: s.title, subject: s.subject, color: s.color, rows: s.rows.map(r => Object.assign({}, r)) };
            sdOpenRow = null;
            sdPalette = false;
            sdConfirmDelete = null;
            if (render !== false) sdRender(true);
        }

        function sdStopEdit() {
            sdFlushSave();
            sdEditId = null;
            sdDraft = null;
            sdOpenRow = null;
            sdRender(true);
        }

        function sdQueueSave() {
            clearTimeout(sdSaveTimer);
            sdSaveTimer = setTimeout(sdFlushSave, 350);
        }

        function sdFlushSave() {
            clearTimeout(sdSaveTimer);
            sdSaveTimer = null;
            if (!sdEditId || !sdDraft) return;
            const d = sdDraft;
            // Empty rows are kept while you're editing them, never saved.
            const rows = d.rows.filter(r => r.src || r.label || r.id === sdOpenRow);
            sdCall('studyUpdate', sdEditId, { title: d.title, subject: d.subject, color: d.color, rows });
        }

        function sdSyncFloatButton() {
            const panel = document.getElementById('study-panel');
            const btn = panel && panel.querySelector('[data-act="float"][data-editor]');
            if (!btn || !sdEditId) return;
            const open = sdIsOpen(sdEditId);
            btn.classList.toggle('sd-btn-on', open);
            btn.classList.toggle('sd-btn-accent', !open);
            const label = btn.querySelector('span');
            if (label) label.textContent = open ? 'On screen' : 'Pop out';
            const icon = btn.querySelector('i');
            if (icon) icon.className = 'fas ' + (open ? 'fa-check' : 'fa-up-right-from-square');
        }

        function sdEditorEl() {
            const d = sdDraft;
            const open = sdIsOpen(sdEditId);
            const subjects = [...new Set(StE.SUBJECTS.concat(sdState.sheets.map(s => s.subject)).filter(Boolean))];
            const view = sdH('div', { class: 'sd-view sd-editor' },
                sdH('div', { class: 'sd-edit-head' },
                    sdIconBtn('back', 'fa-arrow-left', 'Back to your sheets'),
                    sdH('input', { type: 'text', class: 'sd-input sd-title-input', 'data-field': 'title', value: d.title, maxlength: StE.MAX_TITLE, placeholder: 'Sheet title', spellcheck: 'false' }),
                    sdBtn('float', open ? 'On screen' : 'Pop out', { icon: open ? 'fa-check' : 'fa-up-right-from-square', cls: open ? 'sd-btn-on' : 'sd-btn-accent', data: { 'data-id': sdEditId, 'data-editor': '1' } })),
                sdH('div', { class: 'sd-edit-meta' },
                    sdH('label', { class: 'sd-label' }, sdH('span', { text: 'Subject' }),
                        sdH('input', { type: 'text', class: 'sd-input', 'data-field': 'subject', value: d.subject, maxlength: StE.MAX_SUBJECT, list: 'sd-subjects', placeholder: 'e.g. Physics', spellcheck: 'false' }),
                        sdH('datalist', { id: 'sd-subjects' }, subjects.map(s => sdH('option', { value: s })))),
                    sdH('div', { class: 'sd-colors', role: 'radiogroup', 'aria-label': 'Colour' }, StE.COLORS.map(c => {
                        const b = sdH('button', { type: 'button', class: 'sd-color' + (c === d.color ? ' on' : ''), 'data-act': 'color', 'data-color': c, title: 'Colour', 'aria-label': 'Colour ' + c });
                        b.style.setProperty('--c', c);
                        return b;
                    }))),
                sdH('div', { class: 'sd-rows' }, d.rows.length ? d.rows.map((r, i) => (r.id === sdOpenRow ? sdRowEditorEl(r, i) : sdRowViewEl(r, i)))
                    : sdH('p', { class: 'sd-muted sd-pad', text: 'This sheet is empty. Add a formula, or a heading to start a topic.' })),
                sdH('div', { class: 'sd-add' },
                    sdBtn('add-row', 'Formula', { icon: 'fa-plus', cls: 'sd-btn-primary', data: { 'data-kind': 'formula' } }),
                    sdBtn('add-row', 'Heading', { icon: 'fa-heading', data: { 'data-kind': 'heading' } }),
                    sdBtn('add-row', 'Text', { icon: 'fa-paragraph', data: { 'data-kind': 'text' } })),
                sdHelpEl());
            view.style.setProperty('--c', d.color);
            return view;
        }

        function sdRowViewEl(r, i) {
            const tools = sdH('div', { class: 'sd-r-tools' },
                sdIconBtn('row-move', 'fa-arrow-up', 'Move up', { 'data-row': r.id, 'data-dir': '-1', disabled: i === 0 ? 'disabled' : null }),
                sdIconBtn('row-move', 'fa-arrow-down', 'Move down', { 'data-row': r.id, 'data-dir': '1', disabled: i === sdDraft.rows.length - 1 ? 'disabled' : null }),
                sdIconBtn('row-del', 'fa-xmark', 'Remove', { 'data-row': r.id }, 'sd-icon-danger'));
            if (r.kind === 'heading') {
                return sdH('div', { class: 'sd-r sd-r-h', 'data-act': 'row-open', 'data-row': r.id, title: 'Click to edit' },
                    sdH('span', { class: 'sd-ellipsis', text: r.label || 'Untitled heading' }), tools);
            }
            if (r.kind === 'text') {
                return sdH('div', { class: 'sd-r sd-r-t', 'data-act': 'row-open', 'data-row': r.id, title: 'Click to edit' },
                    sdH('span', { text: r.label || 'Empty text' }), tools);
            }
            return sdH('div', { class: 'sd-r sd-r-f', 'data-act': 'row-open', 'data-row': r.id, title: 'Click to edit' },
                sdH('div', { class: 'sd-r-body' },
                    r.label ? sdH('div', { class: 'sd-r-label', text: r.label }) : null,
                    r.src ? sdMath(r.src) : sdH('div', { class: 'sd-muted', text: 'Empty formula' }),
                    r.note ? sdH('div', { class: 'sd-r-note', text: r.note }) : null),
                tools);
        }

        function sdRowEditorEl(r, i) {
            const foot = sdH('div', { class: 'sd-r-foot' },
                sdIconBtn('row-move', 'fa-arrow-up', 'Move up', { 'data-row': r.id, 'data-dir': '-1', disabled: i === 0 ? 'disabled' : null }),
                sdIconBtn('row-move', 'fa-arrow-down', 'Move down', { 'data-row': r.id, 'data-dir': '1', disabled: i === sdDraft.rows.length - 1 ? 'disabled' : null }),
                sdIconBtn('row-del', 'fa-trash-can', 'Remove', { 'data-row': r.id }, 'sd-icon-danger'),
                sdH('span', { class: 'sd-grow' }),
                r.kind === 'formula' ? sdH('span', { class: 'sd-hint', text: 'Enter: next formula · Esc: done' }) : null,
                sdBtn('row-close', 'Done', { icon: 'fa-check', cls: 'sd-btn-sm' }));
            if (r.kind !== 'formula') {
                return sdH('div', { class: 'sd-r sd-r-edit' },
                    sdH('input', { type: 'text', class: 'sd-input' + (r.kind === 'heading' ? ' sd-strong' : ''), 'data-field': 'row-label', 'data-row': r.id, value: r.label,
                        maxlength: r.kind === 'text' ? StE.MAX_NOTE : StE.MAX_LABEL, placeholder: r.kind === 'heading' ? 'Topic heading, e.g. Kinematics' : 'A line of text, e.g. a reminder' }),
                    foot);
            }
            const preview = sdH('div', { class: 'sd-preview', 'data-preview': r.id });
            sdFillPreview(preview, r.src);
            return sdH('div', { class: 'sd-r sd-r-edit' },
                sdH('input', { type: 'text', class: 'sd-input', 'data-field': 'row-label', 'data-row': r.id, value: r.label, maxlength: StE.MAX_LABEL, placeholder: 'Name (optional), e.g. Quadratic formula' }),
                sdH('div', { class: 'sd-src-row' },
                    sdH('input', { type: 'text', class: 'sd-input sd-mono', id: 'sd-src-' + r.id, 'data-field': 'row-src', 'data-row': r.id, value: r.src, maxlength: StE.MAX_SRC,
                        placeholder: 'e.g. x = (-b +- sqrt(b^2 - 4ac))/(2a)', spellcheck: 'false', autocomplete: 'off' }),
                    sdIconBtn('palette', 'fa-keyboard', sdPalette ? 'Hide symbols' : 'Insert symbols', null, sdPalette ? 'on' : '')),
                sdPalette ? sdPaletteEl(r.id) : null,
                preview,
                sdH('input', { type: 'text', class: 'sd-input sd-small', 'data-field': 'row-note', 'data-row': r.id, value: r.note, maxlength: StE.MAX_NOTE, placeholder: 'Note (optional), e.g. units or when it applies' }),
                foot);
        }

        function sdFillPreview(el, src) {
            el.replaceChildren();
            el.classList.remove('bad', 'pending');
            if (!src.trim()) {
                el.appendChild(sdH('span', { class: 'sd-muted', text: 'Your formula appears here as you type.' }));
                return;
            }
            const out = sdTypeset(src);
            if (out.html) {
                const m = sdH('div', { class: 'sd-math' });
                m.innerHTML = out.html;
                el.appendChild(m);
            } else if (out.pending) {
                el.classList.add('pending');
                el.appendChild(sdH('span', { class: 'sd-muted', text: 'Loading the maths renderer…' }));
            } else {
                el.classList.add('bad');
                el.appendChild(sdH('span', { text: 'Can’t typeset this yet — check your brackets. ' }));
                el.appendChild(sdH('span', { class: 'sd-muted', text: out.error || '' }));
            }
            if (out.tex) el.appendChild(sdH('div', { class: 'sd-tex', title: 'The LaTeX this becomes', text: out.tex }));
        }

        function sdPaletteEl(rowId) {
            return sdH('div', { class: 'sd-palette' }, StE.PALETTE.map(g =>
                sdH('div', { class: 'sd-pal-group' },
                    sdH('div', { class: 'sd-pal-title', text: g.group }),
                    sdH('div', { class: 'sd-pal-items' }, g.items.map(it => {
                        const b = sdH('button', { type: 'button', class: 'sd-pal', 'data-act': 'insert', 'data-row': rowId, 'data-ins': it.ins, title: (it.title ? it.title + ' — ' : '') + it.ins.replace('|', '…').trim() });
                        b.appendChild(sdMath(it.tex, 'sd-pal-math'));
                        return b;
                    })))));
        }

        function sdHelpEl() {
            return sdH('details', { class: 'sd-help' },
                sdH('summary', null, sdIcon('fa-circle-question'), sdH('span', { text: 'How to type formulas' })),
                sdH('p', { class: 'sd-muted', text: 'Type the way you would on a calculator. A space ends a fraction’s top or bottom: 1/2 mv^2 is ½mv², while mv^2/r puts mv² over r. Brackets group: (a+b)/(2c).' }),
                sdH('div', { class: 'sd-cheats' }, StE.CHEATSHEET.map(([code, what]) =>
                    sdH('div', { class: 'sd-cheat' },
                        sdH('code', { text: code }),
                        sdH('span', { class: 'sd-muted', text: what })))));
        }

        // ── Starter sheets ────────────────────────────────────────────────────

        function sdStartersEl() {
            const wrap = sdH('div', { class: 'sd-view' },
                sdH('p', { class: 'sd-muted sd-pad', text: 'Ready-made sheets, from school basics to first-year university. Add one to your sheets to pop it out, then edit it however you like.' }));
            const groups = new Map();
            for (const st of StE.STARTERS) {
                if (!groups.has(st.subject)) groups.set(st.subject, []);
                groups.get(st.subject).push(st);
            }
            for (const [subject, list] of groups) {
                wrap.appendChild(sdH('div', { class: 'sd-group' },
                    sdH('div', { class: 'sd-group-title' }, sdH('span', { text: subject })),
                    list.map(sdStarterCard)));
            }
            return wrap;
        }

        function sdStarterCard(st) {
            const added = sdState.sheets.some(s => s.starter === st.id);
            const open = sdPreviewStarter === st.id;
            const n = st.rows.filter(r => r.kind === 'formula').length;
            const sample = st.rows.filter(r => r.kind === 'formula').slice(0, 2);
            const card = sdH('div', { class: 'sd-card sd-starter' + (open ? ' open' : '') },
                sdH('div', { class: 'sd-card-main', 'data-act': 'preview-starter', 'data-id': st.id, title: open ? 'Hide' : 'Show every formula' },
                    sdH('div', { class: 'sd-card-title' }, sdH('span', { class: 'sd-dot' }), sdH('span', { class: 'sd-ellipsis', text: st.title }),
                        added ? sdH('span', { class: 'sd-tag', text: 'Added' }) : null),
                    sdH('div', { class: 'sd-card-meta', text: sdPlural(n, 'formula') + ' · ' + st.blurb }),
                    open ? null : sdH('div', { class: 'sd-samples' }, sample.map(r => sdMath(r.src, 'sd-mini')))),
                sdH('div', { class: 'sd-card-actions' },
                    sdBtn('add-starter', added ? 'Add again' : 'Add to my sheets', { icon: 'fa-plus', cls: 'sd-btn-sm sd-btn-primary', data: { 'data-id': st.id } }),
                    sdBtn('add-starter-float', 'Add & pop out', { icon: 'fa-up-right-from-square', cls: 'sd-btn-sm sd-btn-accent', data: { 'data-id': st.id } }),
                    sdIconBtn('preview-starter', open ? 'fa-chevron-up' : 'fa-chevron-down', open ? 'Hide formulas' : 'Show every formula', { 'data-id': st.id })),
                open ? sdH('div', { class: 'sd-starter-rows' }, st.rows.map(r => {
                    if (r.kind === 'heading') return sdH('div', { class: 'sd-r-h sd-r-h-static', text: r.label });
                    if (r.kind === 'text') return sdH('div', { class: 'sd-r-t', text: r.label });
                    return sdH('div', { class: 'sd-r-f-static' },
                        r.label ? sdH('div', { class: 'sd-r-label', text: r.label }) : null,
                        sdMath(r.src),
                        r.note ? sdH('div', { class: 'sd-r-note', text: r.note }) : null);
                })) : null);
            card.style.setProperty('--c', st.color);
            return card;
        }

        // ── Settings ──────────────────────────────────────────────────────────

        function sdHotkeyText(accel) {
            if (!accel) return 'Not set';
            const raw = accel.replace(/CommandOrControl/g, 'Control');
            return typeof formatHotkeyDisplay === 'function' ? formatHotkeyDisplay(raw) : raw;
        }

        function sdSettingsEl() {
            const S = sdState.settings;
            const seg = (key, options, current) => sdH('div', { class: 'sd-seg' }, options.map(o =>
                sdH('button', { type: 'button', class: 'sd-seg-btn' + (current === o.id ? ' on' : ''), 'data-act': 'set', 'data-key': key, 'data-val': o.id, text: o.label })));
            const hotkeyRow = (key, label, hint) => {
                const listening = sdBinding === key;
                return sdH('div', { class: 'sd-set-row' },
                    sdH('div', null, sdH('div', { class: 'sd-set-label', text: label }), sdH('div', { class: 'sd-hint', text: hint })),
                    sdH('div', { class: 'sd-row' },
                        sdH('span', { class: 'sd-kbd' + (listening ? ' listening' : ''), text: listening ? 'Press a shortcut…' : sdHotkeyText(S[key]) }),
                        sdBtn(listening ? 'unbind-cancel' : 'bind', listening ? 'Cancel' : 'Set', { cls: 'sd-btn-sm', data: { 'data-key': key } }),
                        S[key] && !listening ? sdIconBtn('unbind', 'fa-xmark', 'Clear shortcut', { 'data-key': key }) : null));
            };
            const openSheets = sdState.openFloats.map(sdSheet).filter(Boolean);
            return sdH('div', { class: 'sd-view' },
                sdHiddenBanner(),
                sdH('div', { class: 'sd-section' },
                    sdH('div', { class: 'sd-section-title', text: 'How new overlays look' }),
                    sdH('div', { class: 'sd-set-row' }, sdH('div', { class: 'sd-set-label', text: 'Style' }), seg('floatStyle', SD_STYLES, S.floatStyle)),
                    sdH('div', { class: 'sd-set-row' }, sdH('div', { class: 'sd-set-label', text: 'Text size' }),
                        sdH('div', { class: 'sd-row' },
                            sdIconBtn('scale', 'fa-minus', 'Smaller', { 'data-dir': '-1' }),
                            sdH('span', { class: 'sd-value', text: Math.round(S.floatScale * 100) + '%' }),
                            sdIconBtn('scale', 'fa-plus', 'Bigger', { 'data-dir': '1' }))),
                    sdH('div', { class: 'sd-set-row' }, sdH('div', { class: 'sd-set-label', text: 'Opacity' }),
                        sdH('div', { class: 'sd-row' },
                            sdH('input', { type: 'range', class: 'sd-range', min: String(StE.OPACITY_MIN), max: '100', step: '5', value: String(S.floatOpacity), 'data-field': 'floatOpacity' }),
                            sdH('span', { class: 'sd-value', text: S.floatOpacity + '%' }))),
                    sdH('label', { class: 'sd-check' }, sdH('input', { type: 'checkbox', 'data-field': 'showLabels', checked: S.showLabels }), sdH('span', { text: 'Show formula names' })),
                    sdH('label', { class: 'sd-check' }, sdH('input', { type: 'checkbox', 'data-field': 'showNotes', checked: S.showNotes }), sdH('span', { text: 'Show notes' })),
                    openSheets.length ? sdBtn('apply-all', 'Apply to the overlays on screen', { icon: 'fa-wand-magic-sparkles', cls: 'sd-btn-sm' }) : null,
                    sdH('p', { class: 'sd-hint', text: 'Each overlay also has its own style, text size and opacity — right-click it.' })),
                sdH('div', { class: 'sd-section' },
                    sdH('div', { class: 'sd-section-title', text: 'Hotkeys' }),
                    hotkeyRow('hotkeyToggle', 'Show / hide overlays', 'Hides every formula overlay, or brings them back. With none open, pops out the sheet you used last.'),
                    hotkeyRow('hotkeyGhost', 'Click-through on / off', 'Lets clicks pass through the overlays to the game or app underneath — and back.')),
                sdH('div', { class: 'sd-section' },
                    sdH('div', { class: 'sd-section-title' }, sdH('span', { text: 'On screen now' }), sdH('small', { text: openSheets.length ? String(openSheets.length) + ' of ' + StE.MAX_FLOATS : '' })),
                    openSheets.length ? openSheets.map(s => {
                        const row = sdH('div', { class: 'sd-open-row' }, sdH('span', { class: 'sd-dot' }), sdH('span', { class: 'sd-ellipsis', text: s.title }),
                            sdIconBtn('float-close', 'fa-xmark', 'Close this overlay', { 'data-id': s.id }));
                        row.style.setProperty('--c', s.color);
                        return row;
                    }) : sdH('p', { class: 'sd-muted', text: 'No overlays open. Use Pop out on a sheet.' }),
                    openSheets.length > 1 ? sdBtn('close-all', 'Close all', { cls: 'sd-btn-sm' }) : null),
                sdH('div', { class: 'sd-section' },
                    sdH('div', { class: 'sd-section-title', text: 'Share & back up' }),
                    sdH('div', { class: 'sd-row' },
                        sdBtn('export-all', 'Export all sheets', { icon: 'fa-file-export', cls: 'sd-btn-sm' }),
                        sdBtn('import', 'Import…', { icon: 'fa-file-import', cls: 'sd-btn-sm' })),
                    sdH('p', { class: 'sd-hint', text: 'Exported sheets are a small .json file a classmate can import into their own main.' })));
        }

        // ── Hotkey binding ────────────────────────────────────────────────────

        async function sdBindHotkey(key) {
            if (sdBinding || (typeof bindingTarget !== 'undefined' && bindingTarget)) return;
            sdBinding = key;
            if (typeof disableAllHotkeys === 'function') await disableAllHotkeys();
            window.addEventListener('keydown', sdBindListener, true);
            sdRender(true);
            showToast('Press a shortcut — Esc to cancel');
        }

        async function sdEndBind() {
            window.removeEventListener('keydown', sdBindListener, true);
            sdBinding = null;
            if (typeof enableAllHotkeys === 'function') await enableAllHotkeys();
            sdRender(true);
        }

        async function sdBindListener(e) {
            if (!sdBinding) return;
            // Capture phase on window runs before every document listener, so
            // the Widget Library and the app's close key never see this press.
            e.preventDefault();
            e.stopImmediatePropagation();
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
            const key = sdBinding;
            if (e.key === 'Escape') {
                await sdEndBind();
                showToast('Cancelled');
                return;
            }
            const accel = keyEventToAccelerator(e);
            if (!accel) return;
            const isFKey = /^F\d{1,2}$/.test(accel.split('+').pop());
            if (!isFKey && !(e.ctrlKey || e.altKey || e.metaKey)) {
                showToast('Use Ctrl or Alt with a key — or an F-key', true);
                return;
            }
            const electronAccel = toElectronAccelerator(accel);
            const other = key === 'hotkeyToggle' ? 'hotkeyGhost' : 'hotkeyToggle';
            const takenInApp = typeof hotkeys === 'object' && hotkeys && Object.values(hotkeys).includes(accel);
            await sdEndBind();
            if (takenInApp || (sdState && sdState.settings[other] === electronAccel)) {
                showToast('That shortcut is already used in main', true);
                return;
            }
            const res = await sdCall('studySetSettings', { [key]: electronAccel });
            const failed = res && res.hotkeys && Array.isArray(res.hotkeys.failed) ? res.hotkeys.failed : [];
            if (failed.includes(key === 'hotkeyToggle' ? 'toggle' : 'ghost')) {
                showToast('Another app already uses that shortcut', true);
                await sdCall('studySetSettings', { [key]: '' });
            } else {
                showToast('Shortcut saved');
            }
        }

        // ── Events ────────────────────────────────────────────────────────────

        function sdWire(root) {
            root.addEventListener('click', sdOnClick);
            root.addEventListener('input', sdOnInput);
            root.addEventListener('change', sdOnChange);
            root.addEventListener('keydown', sdOnKey);
        }

        function sdRow(id) { return sdDraft ? sdDraft.rows.find(r => r.id === id) : null; }

        function sdNewRow(kind) {
            return { id: StE.newId('r', Date.now(), Math.random()), kind, label: '', src: '', note: '' };
        }

        function sdFocusSoon(selector) {
            requestAnimationFrame(() => {
                const panel = document.getElementById('study-panel');
                const el = panel && panel.querySelector(selector);
                if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* not a text box */ } }
            });
        }

        function sdAddRow(kind, afterId) {
            if (!sdDraft) return;
            if (sdDraft.rows.length >= StE.MAX_ROWS) { showToast(`Up to ${StE.MAX_ROWS} rows on one sheet`, true); return; }
            const row = sdNewRow(kind);
            const at = afterId ? sdDraft.rows.findIndex(r => r.id === afterId) : -1;
            if (at >= 0) sdDraft.rows.splice(at + 1, 0, row);
            else sdDraft.rows.push(row);
            sdPrune(row.id);
            sdOpenRow = row.id;
            sdRender(true);
            sdFocusSoon(kind === 'formula' ? `[data-field="row-src"][data-row="${row.id}"]` : `[data-field="row-label"][data-row="${row.id}"]`);
            sdQueueSave();
        }

        // A row left empty disappears when you move on from it.
        function sdPrune(keepId) {
            if (sdDraft) sdDraft.rows = sdDraft.rows.filter(r => r.src || r.label || r.id === keepId);
        }

        function sdCloseRow() {
            sdOpenRow = null;
            sdPalette = false;
            sdPrune(null);
            sdFlushSave();
            sdRender(true);
        }

        async function sdOnClick(e) {
            const el = e.target.closest('[data-act]');
            if (!el || el.disabled) return;
            const act = el.dataset.act;
            const id = el.dataset.id;
            // Row tools sit inside a clickable row; don't let them open it too.
            if (el.tagName === 'BUTTON') e.stopPropagation();
            if (act !== 'del') sdConfirmDelete = null;
            switch (act) {
                case 'tab':
                    if (!SD_TABS.some(t => t.id === id)) return;
                    sdFlushSave();
                    sdTab = id;
                    try { localStorage.setItem('studyTab', id); } catch (err) { /* non-fatal */ }
                    sdRender(true);
                    return;
                case 'new': {
                    const res = await sdCall('studyCreate', { title: 'New sheet', subject: 'Other' });
                    // main broadcasts the new state before this reply arrives.
                    if (res && res.ok && res.sheet && sdSheet(res.sheet.id)) {
                        sdTab = 'sheets';
                        sdStartEdit(res.sheet.id);
                        requestAnimationFrame(() => {
                            const t = document.querySelector('#study-panel [data-field="title"]');
                            if (t) { t.focus(); t.select(); }
                        });
                    }
                    return;
                }
                case 'add-starter':
                case 'add-starter-float': {
                    const res = await sdCall('studyCreate', { starter: id, float: act === 'add-starter-float' });
                    if (res && res.ok && res.sheet) showToast(act === 'add-starter-float' ? '“' + res.sheet.title + '” is on screen' : 'Added “' + res.sheet.title + '” to your sheets');
                    return;
                }
                case 'preview-starter':
                    sdPreviewStarter = sdPreviewStarter === id ? null : id;
                    sdRender(true);
                    return;
                case 'edit':
                    sdStartEdit(id);
                    return;
                case 'back':
                    sdStopEdit();
                    return;
                case 'float':
                    if (sdEditId === id) sdFlushSave();
                    await sdCall(sdIsOpen(id) ? 'studyFloatClose' : 'studyFloatOpen', id);
                    return;
                case 'float-close':
                    await sdCall('studyFloatClose', id);
                    return;
                case 'close-all':
                    await sdCall('studyFloatCloseAll');
                    return;
                case 'toggle-overlays':
                    await sdCall('studyToggleOverlays');
                    return;
                case 'dup': {
                    const res = await sdCall('studyDuplicate', id);
                    if (res && res.ok) showToast('Duplicated');
                    return;
                }
                case 'del':
                    if (sdConfirmDelete !== id) {
                        sdConfirmDelete = id;
                        sdRender(true);
                        return;
                    }
                    sdConfirmDelete = null;
                    await sdCall('studyRemove', id);
                    return;
                case 'export-one':
                case 'export-all': {
                    const res = await sdCall('studyExport', act === 'export-one' ? [id] : []);
                    if (res && res.ok) showToast('Exported ' + sdPlural(res.count, 'sheet'));
                    return;
                }
                case 'import': {
                    const res = await sdCall('studyImport');
                    if (res && res.ok) showToast('Imported ' + sdPlural(res.count, 'sheet') + (res.skipped ? ' (' + res.skipped + ' didn’t fit)' : ''));
                    return;
                }
                case 'color':
                    if (!sdDraft) return;
                    sdDraft.color = StE.cleanColor(el.dataset.color, sdDraft.color);
                    sdRender(true);
                    sdQueueSave();
                    return;
                case 'add-row':
                    sdAddRow(el.dataset.kind || 'formula', sdOpenRow);
                    return;
                case 'row-open':
                    if (sdOpenRow === el.dataset.row) return;
                    sdPrune(el.dataset.row);
                    sdFlushSave();
                    sdOpenRow = el.dataset.row;
                    sdRender(true);
                    sdFocusSoon(`[data-row="${el.dataset.row}"][data-field="${(sdRow(el.dataset.row) || {}).kind === 'formula' ? 'row-src' : 'row-label'}"]`);
                    return;
                case 'row-close':
                    sdCloseRow();
                    return;
                case 'row-move': {
                    if (!sdDraft) return;
                    const i = sdDraft.rows.findIndex(r => r.id === el.dataset.row);
                    const j = i + Number(el.dataset.dir);
                    if (i < 0 || j < 0 || j >= sdDraft.rows.length) return;
                    const [row] = sdDraft.rows.splice(i, 1);
                    sdDraft.rows.splice(j, 0, row);
                    sdRender(true);
                    sdQueueSave();
                    return;
                }
                case 'row-del':
                    if (!sdDraft) return;
                    sdDraft.rows = sdDraft.rows.filter(r => r.id !== el.dataset.row);
                    if (sdOpenRow === el.dataset.row) sdOpenRow = null;
                    sdRender(true);
                    sdQueueSave();
                    return;
                case 'palette':
                    sdPalette = !sdPalette;
                    sdRender(true);
                    if (sdOpenRow) sdFocusSoon(`[data-field="row-src"][data-row="${sdOpenRow}"]`);
                    return;
                case 'insert':
                    sdInsert(el.dataset.row, el.dataset.ins || '');
                    return;
                case 'set':
                    await sdCall('studySetSettings', { [el.dataset.key]: el.dataset.val });
                    return;
                case 'scale': {
                    const next = StE.roundScale(sdState.settings.floatScale + Number(el.dataset.dir) * 0.1);
                    await sdCall('studySetSettings', { floatScale: next });
                    return;
                }
                case 'apply-all': {
                    const S = sdState.settings;
                    for (const fid of sdState.openFloats) {
                        await sdCall('studyFloatPrefs', fid, { style: S.floatStyle, scale: S.floatScale, opacity: S.floatOpacity, labels: S.showLabels, notes: S.showNotes });
                    }
                    showToast('Applied');
                    return;
                }
                case 'bind':
                    await sdBindHotkey(el.dataset.key);
                    return;
                case 'unbind-cancel':
                    await sdEndBind();
                    return;
                case 'unbind':
                    await sdCall('studySetSettings', { [el.dataset.key]: '' });
                    return;
                default:
            }
        }

        // Inserts a palette snippet at the caret. `|` in the snippet marks
        // where the caret lands; a word gets a space on either side when it
        // would otherwise run into a neighbouring letter.
        function sdInsert(rowId, snippet) {
            const input = document.querySelector(`#study-panel [data-field="row-src"][data-row="${rowId}"]`);
            if (!input || !snippet) return;
            const start = input.selectionStart == null ? input.value.length : input.selectionStart;
            const end = input.selectionEnd == null ? start : input.selectionEnd;
            let text = snippet;
            let caret = text.indexOf('|');
            text = text.replace('|', '');
            if (caret < 0) caret = text.length;
            const before = input.value.slice(0, start);
            const after = input.value.slice(end);
            if (/^[A-Za-z]/.test(text) && /[A-Za-z]$/.test(before)) { text = ' ' + text; caret++; }
            if (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(after)) text += ' ';
            input.value = (before + text + after).slice(0, StE.MAX_SRC);
            input.focus();
            const pos = Math.min(input.value.length, start + caret);
            input.setSelectionRange(pos, pos);
            sdOnInput({ target: input });
        }

        function sdOnInput(e) {
            const el = e.target;
            const field = el && el.dataset && el.dataset.field;
            if (!field) return;
            if (field === 'query') {
                sdQuery = el.value;
                sdRender(true);
                return;
            }
            if (!sdDraft) return;
            if (field === 'title') sdDraft.title = el.value;
            else if (field === 'subject') sdDraft.subject = el.value;
            else if (field.startsWith('row-')) {
                const row = sdRow(el.dataset.row);
                if (!row) return;
                if (field === 'row-label') row.label = el.value;
                else if (field === 'row-note') row.note = el.value;
                else if (field === 'row-src') {
                    row.src = el.value;
                    const prev = document.querySelector(`#study-panel [data-preview="${row.id}"]`);
                    if (prev) sdFillPreview(prev, row.src);
                }
            } else return;
            sdQueueSave();
        }

        async function sdOnChange(e) {
            const el = e.target;
            const field = el && el.dataset && el.dataset.field;
            if (field === 'floatOpacity') await sdCall('studySetSettings', { floatOpacity: Number(el.value) });
            else if (field === 'showLabels' || field === 'showNotes') await sdCall('studySetSettings', { [field]: !!el.checked });
        }

        function sdOnKey(e) {
            const el = e.target;
            const field = el && el.dataset && el.dataset.field;
            if (!field || !field.startsWith('row-')) {
                if (field === 'title' && e.key === 'Enter') { e.preventDefault(); el.blur(); sdFlushSave(); }
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const row = sdRow(el.dataset.row);
                if (row && row.kind === 'formula' && (row.src || row.label)) sdAddRow('formula', row.id);
                else sdCloseRow();
            }
        }

        // ── Enable / boot ─────────────────────────────────────────────────────

        async function applyStudyEnabled(enabled) {
            sdSubscribe();
            if (!enabled) {
                sdFlushSave();
                if (sdBinding) await sdEndBind();
                sdEditId = null;
                sdDraft = null;
                sdOpenRow = null;
            }
            const s = await sdCall('studySetEnabled', !!enabled);
            if (s && Array.isArray(s.sheets)) sdSetState(s);
            if (enabled) renderStudyPanel();
        }

        function initStudyWidget() {
            sdSubscribe();
            sdRefresh();
        }

        // Esc inside a row's text box closes that row, not the whole widget.
        // The Widget Library claims Escape on document (capture) to close its
        // detail view; a capture listener on window runs before it.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || sdBinding) return;
            const el = e.target;
            if (!el || !el.closest || !el.closest('#study-panel') || !el.dataset || !String(el.dataset.field || '').startsWith('row-')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            sdCloseRow();
        }, true);

        window.addEventListener('beforeunload', () => sdFlushSave());
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStudyWidget);
        else initStudyWidget();
