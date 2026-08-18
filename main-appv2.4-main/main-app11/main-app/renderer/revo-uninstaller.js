        // ── Deep Uninstaller mini widget (Revo-Uninstaller-style) ──
        // Pick one installed program from a searchable list, hit Uninstall, and
        // watch a 6-stage wipe run: restore point → analyze → run the program's
        // own uninstaller → scan for leftovers → (you review + tick) remove
        // leftovers → done. The heavy lifting lives in main/revoUninstaller.js;
        // this file is the panel UI and the little phase state machine.
        //
        // The panel div only exists while the Widget Library detail is open, so
        // every entry point here no-ops when it's absent (mini-widget contract).

        const RU_STAGES = [
            { key: 'restore',   label: 'Create restore point' },
            { key: 'analyze',   label: 'Analyze installation' },
            { key: 'uninstall', label: 'Run the program’s uninstaller' },
            { key: 'scan',      label: 'Scan for leftovers' },
            { key: 'clean',     label: 'Remove leftovers' },
            { key: 'done',      label: 'Finished' }
        ];

        let ruPrograms = [];           // [{id,name,version,publisher,sizeKb,hasLocation}]
        let ruPs = { available: false };
        let ruLoaded = false;
        let ruLoading = false;
        let ruSearch = '';
        let ruSelectedId = null;       // program highlighted in the list
        let ruSession = null;          // live pipeline payload from main
        let ruLeftoverSel = new Set(); // leftover ids ticked for removal
        let ruProgressHooked = false;

        function isRevoUninstallerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.revoUninstaller;
        }

        function ruFmtSize(kb) {
            if (!kb || kb < 1) return '';
            const mb = kb / 1024;
            if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
            if (mb >= 1) return Math.round(mb) + ' MB';
            return kb + ' KB';
        }

        async function renderRevoUninstallerPanel() {
            const panel = document.getElementById('revo-uninstaller-panel');
            if (!panel) return;
            if (!isRevoUninstallerEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.revoUninstallerList) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">Deep Uninstaller is unavailable.</p>`;
                return;
            }

            if (!ruProgressHooked && window.electronAPI.onRevoUninstallerProgress) {
                window.electronAPI.onRevoUninstallerProgress(ruOnProgress);
                ruProgressHooked = true;
            }

            // First open: resume any in-flight/finished session, else load the list.
            if (!ruLoaded) {
                ruLoaded = true;
                try {
                    const st = await window.electronAPI.revoUninstallerStatus();
                    if (st) {
                        ruPs = st.ps || ruPs;
                        if (st.phase && st.phase !== 'idle') {
                            ruSession = st;
                            if (st.phase === 'review') ruLeftoverSel = new Set((st.leftovers || []).filter(l => l.confidence === 'high').map(l => l.id));
                        }
                    }
                } catch (e) { /* no active session */ }
                if (!ruSession) ruLoadPrograms();
            }

            panel.innerHTML = `<div class="ru-root mt-3">${ruBodyHtml()}</div>`;
        }

        function ruPaint() {
            const panel = document.getElementById('revo-uninstaller-panel');
            if (!panel || !isRevoUninstallerEnabled()) return;
            const root = panel.querySelector('.ru-root');
            if (root) root.innerHTML = ruBodyHtml();
        }

        function ruBodyHtml() {
            // Live wizard takes over the whole panel while a session is present.
            if (ruSession && ruSession.phase && ruSession.phase !== 'idle') return ruWizardHtml();
            return ruListHtml();
        }

        // ── Program list ──
        function ruListHtml() {
            if (!ruPs.available && ruLoaded && !ruLoading && !ruPrograms.length) {
                return `<div class="ru-empty ru-empty-warn">
                        <i class="fas fa-triangle-exclamation"></i>
                        <p>This uninstaller needs Windows PowerShell, which isn't available on this system.</p>
                    </div>`;
            }
            if (ruLoading && !ruPrograms.length) {
                return `<div class="ru-empty"><span class="load-ring mb-2"></span><p>Reading installed programs…</p></div>`;
            }

            const q = ruSearch.trim().toLowerCase();
            const list = q
                ? ruPrograms.filter(p => p.name.toLowerCase().includes(q) || (p.publisher || '').toLowerCase().includes(q))
                : ruPrograms;

            const rows = list.map((p) => {
                const on = p.id === ruSelectedId;
                const meta = [p.version, p.publisher].filter(Boolean).join(' · ');
                const size = ruFmtSize(p.sizeKb);
                return `<button type="button" class="ru-prog ${on ? 'ru-prog-on' : ''} no-drag" data-id="${esc(p.id)}" onclick="ruSelect('${esc(p.id)}')" title="${esc(p.name)}">
                        <span class="ru-prog-main">
                            <span class="ru-prog-name">${esc(p.name)}</span>
                            ${meta ? `<span class="ru-prog-meta">${esc(meta)}</span>` : ''}
                        </span>
                        ${size ? `<span class="ru-prog-size">${size}</span>` : ''}
                    </button>`;
            }).join('');

            const sel = ruSelectedId ? ruPrograms.find(p => p.id === ruSelectedId) : null;

            return `
                <div class="ru-searchbar">
                    <span class="ru-search-wrap">
                        <i class="fas fa-magnifying-glass ru-search-icon"></i>
                        <input type="text" class="ru-search no-drag" placeholder="Search installed programs…" spellcheck="false"
                            value="${esc(ruSearch)}" oninput="ruOnSearch(this.value)">
                    </span>
                    <button type="button" class="ru-btn no-drag" onclick="ruLoadPrograms(true)" title="Rescan installed programs"><i class="fas fa-rotate"></i></button>
                </div>
                <div class="ru-list">${rows || `<div class="ru-empty"><p>${ruPrograms.length ? 'No programs match your search.' : 'No uninstallable programs found.'}</p></div>`}</div>
                <div class="ru-footer">
                    <div class="ru-footer-inner">
                        <span class="ru-footer-count">${sel ? `Selected: <b>${esc(sel.name)}</b>` : `${ruPrograms.length} program${ruPrograms.length === 1 ? '' : 's'} installed`}</span>
                        <button type="button" class="ru-uninstall no-drag" ${sel ? '' : 'disabled'} onclick="ruStartUninstall()">
                            <i class="fas fa-trash-can mr-2"></i>Uninstall
                        </button>
                    </div>
                    <p class="ru-eula">Runs a 6-stage deep uninstall: restore point, run the program’s own uninstaller, then scan &amp; remove leftover files and registry keys. Nothing is deleted without your review.</p>
                </div>`;
        }

        // ── Wizard (running / review / cleaning / done) ──
        function ruWizardHtml() {
            const s = ruSession;
            const stages = (s.stages && s.stages.length) ? s.stages : RU_STAGES.map(x => ({ ...x, status: 'pending' }));
            const finished = s.phase === 'done';

            const steps = stages.map((st, i) => {
                let icon, cls;
                if (st.status === 'done') { icon = '<i class="fas fa-circle-check"></i>'; cls = 'ru-step-done'; }
                else if (st.status === 'failed') { icon = '<i class="fas fa-circle-xmark"></i>'; cls = 'ru-step-fail'; }
                else if (st.status === 'skipped') { icon = '<i class="fas fa-circle-minus"></i>'; cls = 'ru-step-skip'; }
                else if (st.status === 'active') { icon = '<span class="load-ring"></span>'; cls = 'ru-step-active'; }
                else { icon = `<span class="ru-step-num">${i + 1}</span>`; cls = 'ru-step-pending'; }
                return `<div class="ru-step ${cls}">
                        <span class="ru-step-ico">${icon}</span>
                        <span class="ru-step-body">
                            <span class="ru-step-label">${esc(st.label)}</span>
                            ${st.note ? `<span class="ru-step-note">${esc(st.note)}</span>` : ''}
                        </span>
                    </div>`;
            }).join('');

            const logLines = (s.log || []).slice(-6).map(l => `<div class="ru-log-line">${esc(l)}</div>`).join('');

            let action = '';
            if (s.phase === 'review') action = ruLeftoversHtml();
            else if (finished) action = ruSummaryHtml();
            else if (s.phase === 'cleaning') action = `<div class="ru-review-head"><span><span class="load-ring mr-2"></span>Removing leftovers…</span></div>`;
            else action = `<div class="ru-wizard-foot"><button type="button" class="ru-btn ru-btn-danger no-drag" onclick="ruCancel()"><i class="fas fa-stop mr-1.5"></i>Cancel</button></div>`;

            return `
                <div class="ru-wizard-head">
                    <span class="ru-wizard-title"><i class="fas fa-trash-can mr-2 text-neutral-400"></i>${esc(s.program ? s.program.name : 'Uninstalling')}</span>
                    ${finished ? `<button type="button" class="ru-btn no-drag" onclick="ruBackToList()"><i class="fas fa-arrow-left mr-1"></i>Back</button>` : ''}
                </div>
                <div class="ru-steps">${steps}</div>
                ${logLines ? `<div class="ru-log">${logLines}</div>` : ''}
                ${action}`;
        }

        function ruFmtBytes(b) {
            if (!b || b < 1) return '';
            if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
            if (b >= 1048576) return (b / 1048576).toFixed(0) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
            return b + ' B';
        }

        function ruLeftoverRowHtml(it) {
            const on = ruLeftoverSel.has(it.id);
            const icon = it.type === 'folder' ? 'fa-folder'
                : (it.type === 'file' ? 'fa-file'
                    : (it.type === 'regvalue' ? 'fa-terminal' : 'fa-database'));
            const size = ruFmtBytes(it.size);
            let tail = '';
            if (it.result === 'removed') tail = `<i class="fas fa-circle-check ru-lo-badge ru-ok" title="Removed"></i>`;
            else if (it.result === 'failed') tail = `<i class="fas fa-circle-xmark ru-lo-badge ru-fail" title="Could not remove"></i>`;
            else if (size) tail = `<span class="ru-lo-size">${size}</span>`;
            const lowBadge = it.confidence !== 'high'
                ? `<span class="ru-lo-low" title="Broader match (e.g. named after the publisher) — off by default">?</span>` : '';
            return `<label class="ru-lo ${on ? 'ru-lo-on' : ''} ${it.confidence !== 'high' ? 'ru-lo-normal' : ''}" title="${esc(it.path)}">
                    <input type="checkbox" class="ru-check no-drag" ${on ? 'checked' : ''} onchange="ruToggleLeftover('${esc(it.id)}', this.checked)">
                    <i class="fas ${icon} ru-lo-icon"></i>
                    <span class="ru-lo-text">
                        <span class="ru-lo-label">${esc(it.label)}${lowBadge}</span>
                        <span class="ru-lo-path">${esc(it.path)}</span>
                    </span>
                    ${tail}
                </label>`;
        }

        function ruLeftoversHtml() {
            const items = ruSession.leftovers || [];
            if (!items.length) {
                return `<div class="ru-review">
                        <div class="ru-review-head"><span><i class="fas fa-circle-check mr-1.5 ru-ok"></i>Clean uninstall — no leftovers found.</span></div>
                        <div class="ru-wizard-foot">
                            <button type="button" class="ru-clean no-drag" onclick="ruFinish()"><i class="fas fa-flag-checkered mr-2"></i>Finish</button>
                        </div>
                    </div>`;
            }
            const allOn = items.every(it => ruLeftoverSel.has(it.id));

            // Group by category, preserving the (confidence/size) order within each.
            const groups = [];
            const byCat = new Map();
            for (const it of items) {
                if (!byCat.has(it.category)) { byCat.set(it.category, []); groups.push(it.category); }
                byCat.get(it.category).push(it);
            }
            const body = groups.map((cat) => {
                const rows = byCat.get(cat).map(ruLeftoverRowHtml).join('');
                return `<div class="ru-lo-group">
                        <div class="ru-lo-cat">${esc(cat)}<span class="ru-lo-cat-n">${byCat.get(cat).length}</span></div>
                        ${rows}
                    </div>`;
            }).join('');

            const n = ruLeftoverSel.size;
            const normalCount = items.filter(it => it.confidence !== 'high').length;
            return `<div class="ru-review">
                    <div class="ru-review-head">
                        <span><i class="fas fa-broom mr-1.5 text-neutral-400"></i>${items.length} leftover${items.length === 1 ? '' : 's'} found — tick what to remove</span>
                        <button type="button" class="ru-col-all no-drag" onclick="ruToggleAllLeftovers()">${allOn ? 'None' : 'All'}</button>
                    </div>
                    <div class="ru-lo-list">${body}</div>
                    ${normalCount ? `<p class="ru-lo-hint"><span class="ru-lo-low">?</span> ${normalCount} broader match${normalCount === 1 ? '' : 'es'} (named after the publisher, may be shared with other apps) are left unticked — review before removing.</p>` : ''}
                    <div class="ru-wizard-foot">
                        <button type="button" class="ru-btn no-drag" onclick="ruFinish()">Skip cleanup</button>
                        <button type="button" class="ru-clean no-drag" ${n ? '' : 'disabled'} onclick="ruClean()">
                            <i class="fas fa-broom mr-2"></i>Remove ${n ? n + ' item' + (n === 1 ? '' : 's') : 'leftovers'}
                        </button>
                    </div>
                </div>`;
        }

        function ruSummaryHtml() {
            const sm = ruSession.summary || {};
            if (sm.cancelled) {
                return `<div class="ru-review">
                        <div class="ru-review-head"><span><i class="fas fa-ban mr-1.5 ru-fail"></i>Uninstall cancelled.</span></div>
                        <div class="ru-wizard-foot"><button type="button" class="ru-btn ru-btn-primary no-drag" onclick="ruBackToList()">Back to list</button></div>
                    </div>`;
            }
            const parts = [];
            if (sm.removed) parts.push(`${sm.removed} leftover${sm.removed === 1 ? '' : 's'} removed`);
            if (sm.failed) parts.push(`${sm.failed} failed`);
            if (sm.kept) parts.push(`${sm.kept} kept`);
            return `<div class="ru-review">
                    <div class="ru-review-head"><span><i class="fas fa-flag-checkered mr-1.5 ru-ok"></i>Done — ${parts.join(' · ') || 'nothing left to clean'}</span></div>
                    <div class="ru-wizard-foot"><button type="button" class="ru-btn ru-btn-primary no-drag" onclick="ruBackToList()"><i class="fas fa-arrow-left mr-1"></i>Back to list</button></div>
                </div>`;
        }

        // ── Data + events ──
        async function ruLoadPrograms(force = false) {
            if (!window.electronAPI?.revoUninstallerList) return;
            ruLoading = true;
            if (force) { ruPrograms = []; ruSelectedId = null; }
            ruPaint();
            try {
                const res = await window.electronAPI.revoUninstallerList(force);
                if (res?.ok && Array.isArray(res.programs)) {
                    // Biggest first (like Programs & Features sorted by size); items
                    // with an unknown size fall to the bottom, alphabetical there.
                    ruPrograms = res.programs.sort((a, b) =>
                        (b.sizeKb || 0) - (a.sizeKb || 0) ||
                        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                } else if (res && res.error === 'ps-missing') {
                    ruPs = { available: false };
                }
            } catch (e) {
                console.error('Deep Uninstaller: list failed', e);
            }
            ruLoading = false;
            ruPaint();
        }

        function ruOnSearch(v) {
            ruSearch = v || '';
            // Repaint only the list + footer so the input keeps focus/caret.
            const root = document.querySelector('#revo-uninstaller-panel .ru-root');
            if (!root) return;
            const listEl = root.querySelector('.ru-list');
            if (listEl) {
                // Rebuild the whole list body (cheap) but leave the search input node intact.
                const tmp = document.createElement('div');
                tmp.innerHTML = ruListHtml();
                const newList = tmp.querySelector('.ru-list');
                const newFooter = tmp.querySelector('.ru-footer');
                if (newList) listEl.replaceWith(newList);
                const footEl = root.querySelector('.ru-footer');
                if (footEl && newFooter) footEl.replaceWith(newFooter);
            }
        }

        function ruSelect(id) {
            ruSelectedId = (ruSelectedId === id) ? null : id;
            const root = document.querySelector('#revo-uninstaller-panel .ru-root');
            if (!root) { ruPaint(); return; }
            // Update just the row highlight + footer in place so the list keeps its
            // scroll position (rebuilding the whole panel would jump back to top).
            root.querySelectorAll('.ru-prog').forEach((el) => {
                el.classList.toggle('ru-prog-on', el.getAttribute('data-id') === ruSelectedId);
            });
            const foot = root.querySelector('.ru-footer');
            if (foot) {
                const tmp = document.createElement('div');
                tmp.innerHTML = ruListHtml();
                const next = tmp.querySelector('.ru-footer');
                if (next) foot.replaceWith(next);
            }
        }

        async function ruStartUninstall() {
            if (!ruSelectedId || !window.electronAPI?.revoUninstallerUninstall) return;
            const prog = ruPrograms.find(p => p.id === ruSelectedId);
            if (!prog) return;
            // Optimistic switch to the wizard so the UI reacts instantly; the
            // stream of progress events fills in the real stage state.
            ruSession = {
                phase: 'running',
                program: { id: prog.id, name: prog.name },
                stages: RU_STAGES.map(x => ({ ...x, status: 'pending' })),
                log: [], leftovers: []
            };
            ruPaint();
            showToast(`Uninstalling ${prog.name}…`);
            try {
                const res = await window.electronAPI.revoUninstallerUninstall(prog.id);
                if (res && !res.ok) {
                    ruSession = null;
                    ruPaint();
                    if (res.error === 'ps-missing') showToast('PowerShell is not available', true);
                    else if (res.error === 'already-running') showToast('An uninstall is already running', true);
                    else showToast('Could not start the uninstall', true);
                }
                // Success path is driven by the progress events.
            } catch (e) {
                ruSession = null;
                ruPaint();
                showToast('Uninstall failed to start', true);
            }
        }

        function ruOnProgress(data) {
            if (!data) return;
            ruSession = data;
            if (data.phase === 'review') {
                // Default: tick only the high-confidence leftovers (unambiguous
                // matches). Broader publisher-named matches start unticked so the
                // user opts in after reviewing them.
                ruLeftoverSel = new Set((data.leftovers || []).filter(l => l.confidence === 'high').map(l => l.id));
            }
            if (data.finished) {
                const sm = data.summary || {};
                if (data.cancelled) showToast('Uninstall cancelled');
                else showToast(`Uninstall complete${sm.removed ? ` — ${sm.removed} leftover${sm.removed === 1 ? '' : 's'} removed` : ''}`);
            }
            if (document.getElementById('revo-uninstaller-panel') && isRevoUninstallerEnabled()) ruPaint();
        }

        function ruToggleLeftover(id, on) {
            if (on) ruLeftoverSel.add(id); else ruLeftoverSel.delete(id);
            // Repaint just the review block so checkbox + count stay in sync.
            const root = document.querySelector('#revo-uninstaller-panel .ru-root');
            const rev = root && root.querySelector('.ru-review');
            if (rev) {
                const tmp = document.createElement('div');
                tmp.innerHTML = ruLeftoversHtml();
                const next = tmp.querySelector('.ru-review');
                if (next) rev.replaceWith(next);
            }
        }

        function ruToggleAllLeftovers() {
            const items = (ruSession && ruSession.leftovers) || [];
            const allOn = items.every(it => ruLeftoverSel.has(it.id));
            ruLeftoverSel = new Set(allOn ? [] : items.map(it => it.id));
            ruToggleLeftover(); // repaint review block
        }

        async function ruClean() {
            if (!window.electronAPI?.revoUninstallerClean) return;
            const ids = [...ruLeftoverSel];
            if (ruSession) ruSession.phase = 'cleaning';
            ruPaint();
            try {
                await window.electronAPI.revoUninstallerClean(ids);
                // Progress events carry us to the done summary.
            } catch (e) {
                showToast('Cleanup failed', true);
            }
        }

        async function ruFinish() {
            // Finish without removing anything (empty selection → straight to done).
            if (!window.electronAPI?.revoUninstallerClean) return;
            if (ruSession) ruSession.phase = 'cleaning';
            ruPaint();
            try { await window.electronAPI.revoUninstallerClean([]); }
            catch (e) { showToast('Could not finish', true); }
        }

        async function ruCancel() {
            if (!window.electronAPI?.revoUninstallerCancel) return;
            await window.electronAPI.revoUninstallerCancel();
            showToast('Cancelling…');
        }

        async function ruBackToList() {
            if (window.electronAPI?.revoUninstallerReset) {
                try { await window.electronAPI.revoUninstallerReset(); } catch (e) { /* non-fatal */ }
            }
            ruSession = null;
            ruSelectedId = null;
            ruLeftoverSel = new Set();
            ruPaint();
            ruLoadPrograms(true);
        }
