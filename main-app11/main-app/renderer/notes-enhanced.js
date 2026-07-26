        // ── Quick Notes Enhanced ──────────────────────────────────────────────
        //
        // An opt-in mini widget (id 'notesEnhanced') that upgrades the Quick Notes
        // dashboard card from a single scratch textarea into a multi-note editor
        // with tabs, a checklist mode, live Markdown preview, and per-note version
        // history. Off by default; when disabled the card falls back to the basic
        // textarea (#notes-basic bound to localStorage 'main-notes'), which is left
        // completely untouched so nothing is lost either way.
        //
        // Storage (localStorage):
        //   notesEnhancedData  { notes: [ {id,title,type,text,checklist,updatedAt} ], activeId }
        //   notesHistory       { [noteId]: [ {text,checklist,ts} ] }  (capped)
        // Keys are kept stable and independent from 'main-notes'.

        const NOTES_HISTORY_MAX = 25;
        // How long the editor must be idle before the current state is pushed as a
        // history snapshot — avoids one snapshot per keystroke.
        const NOTES_HISTORY_DEBOUNCE_MS = 1500;

        // Per-note transient view state (not persisted): whether Markdown preview is
        // on for the active note, and whether the history dropdown is open.
        let notesPreviewMode = false;
        let notesHistoryOpen = false;
        let notesHistoryTimer = null;

        function getNotesData() {
            const data = safeParseJSON(localStorage.getItem('notesEnhancedData'), null);
            if (data && Array.isArray(data.notes) && data.notes.length) return data;
            // Seed from the basic scratch note the first time Enhanced is used, so
            // whatever was already typed carries over instead of vanishing.
            const seedText = localStorage.getItem('main-notes') || '';
            const first = newNoteObject('Note 1', seedText);
            const fresh = { notes: [first], activeId: first.id };
            saveNotesData(fresh);
            return fresh;
        }

        function saveNotesData(data) {
            localStorage.setItem('notesEnhancedData', JSON.stringify(data));
            scheduleSettingsSave();
        }

        function newNoteObject(title, text) {
            return {
                id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                title: title || 'Untitled',
                type: 'text',            // 'text' | 'checklist'
                text: text || '',
                checklist: [],           // [{ text, done }]
                updatedAt: Date.now()
            };
        }

        function getActiveNote(data) {
            return data.notes.find(n => n.id === data.activeId) || data.notes[0];
        }

        // ── History ───────────────────────────────────────────────────────────

        function getNotesHistory() {
            return safeParseJSON(localStorage.getItem('notesHistory'), {});
        }

        function saveNotesHistory(hist) {
            localStorage.setItem('notesHistory', JSON.stringify(hist));
        }

        function pushNoteHistory(note) {
            const hist = getNotesHistory();
            const stack = hist[note.id] || [];
            const snapshot = {
                text: note.text,
                checklist: note.checklist,
                type: note.type,
                ts: Date.now()
            };
            const last = stack[0];
            // Skip if nothing changed since the last snapshot.
            if (last && last.text === snapshot.text && last.type === snapshot.type &&
                JSON.stringify(last.checklist) === JSON.stringify(snapshot.checklist)) {
                return;
            }
            stack.unshift(snapshot);
            if (stack.length > NOTES_HISTORY_MAX) stack.length = NOTES_HISTORY_MAX;
            hist[note.id] = stack;
            saveNotesHistory(hist);
        }

        function scheduleNoteHistory(note) {
            clearTimeout(notesHistoryTimer);
            const id = note.id;
            notesHistoryTimer = setTimeout(() => {
                const data = getNotesData();
                const n = data.notes.find(x => x.id === id);
                if (n) pushNoteHistory(n);
            }, NOTES_HISTORY_DEBOUNCE_MS);
        }

        // Drop history for notes that no longer exist (housekeeping on delete).
        function pruneNotesHistory(data) {
            const hist = getNotesHistory();
            const ids = new Set(data.notes.map(n => n.id));
            let changed = false;
            for (const key of Object.keys(hist)) {
                if (!ids.has(key)) { delete hist[key]; changed = true; }
            }
            if (changed) saveNotesHistory(hist);
        }

        // ── Markdown (minimal, safe) ──────────────────────────────────────────
        // A small, self-contained renderer — no external library. Everything is
        // HTML-escaped first, so inline formatting can only ever produce the tags
        // we explicitly emit; user text can never inject markup.

        function renderMarkdown(src) {
            const escd = esc(src || '');
            const lines = escd.split('\n');
            let html = '';
            let inList = null; // 'ul' | 'ol' | null
            let inCode = false;
            const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };

            const inline = (s) => s
                .replace(/`([^`]+)`/g, '<code>$1</code>')
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
                .replace(/~~([^~]+)~~/g, '<del>$1</del>')
                .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                    '<a href="$2" onclick="event.preventDefault();openNoteLink(this.href)">$1</a>');

            for (const line of lines) {
                if (/^```/.test(line.trim())) {
                    closeList();
                    if (!inCode) { html += '<pre><code>'; inCode = true; }
                    else { html += '</code></pre>'; inCode = false; }
                    continue;
                }
                if (inCode) { html += line + '\n'; continue; }

                const h = line.match(/^(#{1,3})\s+(.*)$/);
                if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }

                const ul = line.match(/^[-*]\s+(.*)$/);
                if (ul) {
                    if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; }
                    html += `<li>${inline(ul[1])}</li>`;
                    continue;
                }
                const ol = line.match(/^\d+\.\s+(.*)$/);
                if (ol) {
                    if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; }
                    html += `<li>${inline(ol[1])}</li>`;
                    continue;
                }
                closeList();
                if (line.trim() === '') { html += '<br>'; continue; }
                html += `<p>${inline(line)}</p>`;
            }
            closeList();
            if (inCode) html += '</code></pre>';
            return html;
        }

        function openNoteLink(url) {
            if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
        }

        // ── Enable / render ───────────────────────────────────────────────────

        function applyNotesEnhancedEnabled(enabled) {
            const basic = document.getElementById('notes-basic');
            const enh = document.getElementById('notes-enhanced');
            if (!basic || !enh) return;
            basic.classList.toggle('hidden', !!enabled);
            enh.classList.toggle('hidden', !enabled);
            if (enabled) {
                notesHistoryOpen = false;
                renderNotesEnhanced();
            }
        }

        function isNotesEnhancedEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.notesEnhanced;
        }

        function renderNotesEnhanced() {
            const host = document.getElementById('notes-enhanced');
            if (!host || host.classList.contains('hidden')) return;
            const data = getNotesData();
            const active = getActiveNote(data);
            if (!active) return;

            const tabs = data.notes.map(n => `
                <button type="button" class="notes-tab no-drag${n.id === active.id ? ' active' : ''}"
                    data-note="${n.id}" title="${esc(n.title)}">
                    <i class="fas ${n.type === 'checklist' ? 'fa-list-check' : 'fa-file-lines'} text-[8px]"></i>
                    <span>${esc(n.title)}</span>
                </button>`).join('');

            host.innerHTML = `
                <div class="notes-enh-head">
                    <div class="notes-tabs no-drag">${tabs}</div>
                    <button type="button" class="notes-icon-btn no-drag" title="New note" data-act="add">
                        <i class="fas fa-plus text-[10px]"></i>
                    </button>
                </div>
                <div class="notes-toolbar no-drag">
                    <input type="text" class="notes-title-input" value="${esc(active.title)}" data-act="title"
                        title="Rename note" spellcheck="false">
                    <div class="notes-tool-group">
                        <button type="button" class="notes-icon-btn${active.type === 'text' ? ' on' : ''}" data-act="mode-text" title="Text / Markdown"><i class="fas fa-align-left text-[10px]"></i></button>
                        <button type="button" class="notes-icon-btn${active.type === 'checklist' ? ' on' : ''}" data-act="mode-check" title="Checklist"><i class="fas fa-list-check text-[10px]"></i></button>
                        ${active.type === 'text' ? `<button type="button" class="notes-icon-btn${notesPreviewMode ? ' on' : ''}" data-act="preview" title="Toggle Markdown preview"><i class="fas fa-eye text-[10px]"></i></button>` : ''}
                        <button type="button" class="notes-icon-btn${notesHistoryOpen ? ' on' : ''}" data-act="history" title="History"><i class="fas fa-clock-rotate-left text-[10px]"></i></button>
                        <button type="button" class="notes-icon-btn notes-danger" data-act="delete" title="Delete note"${data.notes.length <= 1 ? ' disabled' : ''}><i class="fas fa-trash text-[9px]"></i></button>
                    </div>
                </div>
                <div class="notes-body">${renderNotesBody(active)}</div>
                ${notesHistoryOpen ? renderNotesHistoryPanel(active) : ''}
            `;

            wireNotesEnhanced(host, data, active);
        }

        function renderNotesBody(note) {
            if (note.type === 'checklist') {
                const items = (note.checklist || []).map((it, i) => `
                    <li class="notes-check-item${it.done ? ' done' : ''}">
                        <button type="button" class="notes-check-box no-drag" data-check="${i}">
                            <i class="fas fa-check text-[8px]"></i>
                        </button>
                        <input type="text" class="notes-check-text" value="${esc(it.text)}" data-checktext="${i}" spellcheck="false">
                        <button type="button" class="notes-check-del no-drag" data-checkdel="${i}" title="Remove"><i class="fas fa-xmark text-[9px]"></i></button>
                    </li>`).join('');
                return `<ul class="notes-checklist">${items}</ul>
                    <button type="button" class="notes-add-item no-drag" data-act="add-item"><i class="fas fa-plus text-[8px] mr-1"></i>Add item</button>`;
            }
            if (notesPreviewMode) {
                return `<div class="notes-md-preview">${renderMarkdown(note.text)}</div>`;
            }
            return `<textarea class="notes-textarea" data-act="text" spellcheck="false"
                placeholder="Write here… Markdown supported (# heading, **bold**, - list)">${esc(note.text)}</textarea>`;
        }

        function renderNotesHistoryPanel(note) {
            const hist = getNotesHistory()[note.id] || [];
            const rows = hist.length ? hist.map((h, i) => {
                const preview = h.type === 'checklist'
                    ? `${(h.checklist || []).length} item${(h.checklist || []).length === 1 ? '' : 's'}`
                    : (h.text || '').replace(/\s+/g, ' ').trim().slice(0, 42) || '(empty)';
                return `<button type="button" class="notes-hist-row no-drag" data-hist="${i}">
                        <span class="notes-hist-time">${noteRelTime(h.ts)}</span>
                        <span class="notes-hist-prev">${esc(preview)}</span>
                    </button>`;
            }).join('') : '<div class="notes-hist-empty">No history yet</div>';
            return `<div class="notes-history-panel">
                    <div class="notes-history-head"><span>History</span>
                        <button type="button" class="notes-icon-btn no-drag" data-act="hist-clear" title="Clear history"><i class="fas fa-trash text-[9px]"></i></button>
                    </div>
                    <div class="notes-history-list">${rows}</div>
                </div>`;
        }

        function noteRelTime(ts) {
            const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
            if (s < 60) return `${s}s ago`;
            const m = Math.floor(s / 60);
            if (m < 60) return `${m}m ago`;
            const h = Math.floor(m / 60);
            if (h < 24) return `${h}h ago`;
            return `${Math.floor(h / 24)}d ago`;
        }

        // ── Interaction wiring ────────────────────────────────────────────────

        function wireNotesEnhanced(host, data, active) {
            // Tab switching.
            host.querySelectorAll('.notes-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.note;
                    if (id === data.activeId) return;
                    data.activeId = id;
                    notesPreviewMode = false;
                    notesHistoryOpen = false;
                    saveNotesData(data);
                    renderNotesEnhanced();
                });
            });

            host.querySelectorAll('[data-act]').forEach(el => {
                const act = el.dataset.act;
                if (act === 'add') el.addEventListener('click', () => notesAddNote(data));
                else if (act === 'delete') el.addEventListener('click', () => notesDeleteNote(data, active));
                else if (act === 'mode-text') el.addEventListener('click', () => notesSetMode(data, active, 'text'));
                else if (act === 'mode-check') el.addEventListener('click', () => notesSetMode(data, active, 'checklist'));
                else if (act === 'preview') el.addEventListener('click', () => { notesPreviewMode = !notesPreviewMode; renderNotesEnhanced(); });
                else if (act === 'history') el.addEventListener('click', () => { notesHistoryOpen = !notesHistoryOpen; renderNotesEnhanced(); });
                else if (act === 'add-item') el.addEventListener('click', () => notesAddChecklistItem(data, active));
                else if (act === 'hist-clear') el.addEventListener('click', () => notesClearHistory(active));
            });

            // Title rename.
            const titleInput = host.querySelector('[data-act="title"]');
            if (titleInput) {
                titleInput.addEventListener('input', () => {
                    active.title = titleInput.value.trim() || 'Untitled';
                    active.updatedAt = Date.now();
                    // Update only the matching tab label to avoid stealing focus.
                    const tab = host.querySelector(`.notes-tab[data-note="${active.id}"] span`);
                    if (tab) tab.textContent = active.title;
                    saveNotesData(data);
                });
            }

            // Text editor.
            const ta = host.querySelector('.notes-textarea');
            if (ta) {
                ta.addEventListener('input', () => {
                    active.text = ta.value;
                    active.updatedAt = Date.now();
                    saveNotesData(data);
                    scheduleNoteHistory(active);
                });
            }

            // Checklist items.
            host.querySelectorAll('[data-check]').forEach(box => {
                box.addEventListener('click', () => {
                    const i = parseInt(box.dataset.check, 10);
                    if (active.checklist[i]) {
                        active.checklist[i].done = !active.checklist[i].done;
                        active.updatedAt = Date.now();
                        saveNotesData(data);
                        pushNoteHistory(active);
                        renderNotesEnhanced();
                    }
                });
            });
            host.querySelectorAll('[data-checktext]').forEach(inp => {
                inp.addEventListener('input', () => {
                    const i = parseInt(inp.dataset.checktext, 10);
                    if (active.checklist[i]) {
                        active.checklist[i].text = inp.value;
                        active.updatedAt = Date.now();
                        saveNotesData(data);
                        scheduleNoteHistory(active);
                    }
                });
            });
            host.querySelectorAll('[data-checkdel]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const i = parseInt(btn.dataset.checkdel, 10);
                    active.checklist.splice(i, 1);
                    active.updatedAt = Date.now();
                    saveNotesData(data);
                    pushNoteHistory(active);
                    renderNotesEnhanced();
                });
            });

            // History restore.
            host.querySelectorAll('[data-hist]').forEach(row => {
                row.addEventListener('click', () => {
                    const i = parseInt(row.dataset.hist, 10);
                    const snap = (getNotesHistory()[active.id] || [])[i];
                    if (!snap) return;
                    active.text = snap.text || '';
                    active.checklist = Array.isArray(snap.checklist) ? snap.checklist.map(x => ({ ...x })) : [];
                    active.type = snap.type || 'text';
                    active.updatedAt = Date.now();
                    saveNotesData(data);
                    notesHistoryOpen = false;
                    renderNotesEnhanced();
                    showToast('Note restored');
                });
            });
        }

        function notesAddNote(data) {
            const n = newNoteObject('Note ' + (data.notes.length + 1), '');
            data.notes.push(n);
            data.activeId = n.id;
            notesPreviewMode = false;
            notesHistoryOpen = false;
            saveNotesData(data);
            renderNotesEnhanced();
        }

        function notesDeleteNote(data, active) {
            if (data.notes.length <= 1) return;
            const idx = data.notes.findIndex(n => n.id === active.id);
            data.notes.splice(idx, 1);
            data.activeId = data.notes[Math.max(0, idx - 1)].id;
            pruneNotesHistory(data);
            notesHistoryOpen = false;
            saveNotesData(data);
            renderNotesEnhanced();
            showToast('Note deleted');
        }

        function notesSetMode(data, active, mode) {
            if (active.type === mode) return;
            // Convert between representations so no content is lost on switch.
            if (mode === 'checklist') {
                const lines = (active.text || '').split('\n').map(l => l.trim()).filter(Boolean);
                if (!active.checklist.length) {
                    active.checklist = lines.map(l => ({ text: l.replace(/^[-*]\s*/, ''), done: false }));
                }
                if (!active.checklist.length) active.checklist = [{ text: '', done: false }];
            } else {
                if (!active.text && active.checklist.length) {
                    active.text = active.checklist.map(it => `- ${it.done ? '[x] ' : ''}${it.text}`).join('\n');
                }
            }
            active.type = mode;
            active.updatedAt = Date.now();
            notesPreviewMode = false;
            saveNotesData(data);
            pushNoteHistory(active);
            renderNotesEnhanced();
        }

        function notesAddChecklistItem(data, active) {
            active.checklist.push({ text: '', done: false });
            active.updatedAt = Date.now();
            saveNotesData(data);
            renderNotesEnhanced();
            // Focus the newly added item's text field.
            const inputs = document.querySelectorAll('#notes-enhanced [data-checktext]');
            if (inputs.length) inputs[inputs.length - 1].focus();
        }

        function notesClearHistory(active) {
            const hist = getNotesHistory();
            delete hist[active.id];
            saveNotesHistory(hist);
            renderNotesEnhanced();
            showToast('History cleared');
        }

        // ── Config panel (Widget Library detail) ──────────────────────────────
        // No-ops when the panel div is absent (only present while the detail view
        // is open), per the Widget Library contract.

        function renderNotesEnhancedPanel() {
            const panel = document.getElementById('notes-enhanced-panel');
            if (!panel) return;
            const enabled = isNotesEnhancedEnabled();
            if (!enabled) {
                panel.innerHTML = `<p class="text-xs text-neutral-500 leading-relaxed">
                    Enable Quick Notes Enhanced to turn the Quick Notes card into a
                    multi-note editor with tabs, checklists, Markdown preview and
                    per-note history. Your existing note is kept.</p>`;
                return;
            }
            const data = getNotesData();
            const hist = getNotesHistory();
            const totalSnaps = Object.values(hist).reduce((a, s) => a + (s ? s.length : 0), 0);
            panel.innerHTML = `
                <div class="border border-white/10 rounded-xl p-4 space-y-3">
                    <div class="flex items-center justify-between">
                        <p class="text-xs text-neutral-400">${data.notes.length} note${data.notes.length === 1 ? '' : 's'} · ${totalSnaps} history snapshot${totalSnaps === 1 ? '' : 's'}</p>
                        <button type="button" onclick="notesPanelClearAllHistory()"
                            class="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-[11px] transition-colors no-drag">
                            Clear all history</button>
                    </div>
                    <p class="text-[11px] text-neutral-600 leading-relaxed">
                        Edit notes directly on the Quick Notes card. Use the tab bar to
                        switch or add notes, the list icon for checklist mode, the eye
                        for Markdown preview, and the clock for version history.</p>
                </div>`;
        }

        function notesPanelClearAllHistory() {
            saveNotesHistory({});
            if (typeof renderNotesEnhancedPanel === 'function') renderNotesEnhancedPanel();
            if (!document.getElementById('notes-enhanced')?.classList.contains('hidden')) renderNotesEnhanced();
            showToast('All note history cleared');
        }
