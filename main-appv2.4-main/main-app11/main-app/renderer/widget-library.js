        // ── WIDGET LIBRARY ──
        // Browse / search / favourite UI over the MINI_WIDGETS registry (core.js).
        // The library modal, the dashboard Mini Widgets strip, and the Settings
        // summary are all generated from the registry — no hardcoded widget lists.
        //
        // Storage keys:
        //   miniWidgetPrefs    { id: bool }  enabled map (pre-existing key — old
        //                                    installs migrate automatically)
        //   miniWidgetFavs     [id, ...]     favourites
        //   miniWidgetRecents  [id, ...]     most-recently-opened, newest first
        //   widgetLibCategory  string        last selected category chip

        const WIDGET_RECENTS_MAX = 6;

        let widgetLibQuery = '';
        let widgetLibCategory = localStorage.getItem('widgetLibCategory') || 'All';
        let widgetLibSelIndex = -1;   // keyboard-selected card index (into visible list)
        let widgetLibVisibleIds = []; // ids currently shown in the grid, in DOM order
        let widgetDetailId = null;    // id shown in the detail panel, null when closed

        // ── State helpers ─────────────────────────────────────────────────────

        function getMiniWidgetById(id) {
            return MINI_WIDGETS.find(w => w.id === id) || null;
        }

        function isMiniWidgetEnabled(id) {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs[id];
        }

        function getWidgetFavs() {
            const favs = safeParseJSON(localStorage.getItem('miniWidgetFavs'), []);
            return Array.isArray(favs) ? favs.filter(id => getMiniWidgetById(id)) : [];
        }

        function isWidgetFav(id) {
            return getWidgetFavs().includes(id);
        }

        function getWidgetRecents() {
            const recents = safeParseJSON(localStorage.getItem('miniWidgetRecents'), []);
            return Array.isArray(recents) ? recents.filter(id => getMiniWidgetById(id)) : [];
        }

        function recordWidgetRecent(id) {
            try {
                const recents = getWidgetRecents().filter(r => r !== id);
                recents.unshift(id);
                localStorage.setItem('miniWidgetRecents', JSON.stringify(recents.slice(0, WIDGET_RECENTS_MAX)));
            } catch (e) {
                console.error('Widget Library: failed to record recent widget', e);
            }
        }

        // ── Hide-info toggle ──────────────────────────────────────────────────
        // A single library-wide switch that hides the wordy widget descriptions —
        // the card blurbs and the detail view's long description + features list —
        // for people who know what each widget does and just want the controls.
        // Persisted in localStorage ('miniWidgetHideInfo'); default: show info.
        function isWidgetInfoHidden() {
            return localStorage.getItem('miniWidgetHideInfo') === 'true';
        }

        function updateWidgetInfoToggleBtn() {
            const btn = document.getElementById('widget-info-toggle');
            if (!btn) return;
            const hidden = isWidgetInfoHidden();
            const icon = btn.querySelector('i');
            if (icon) icon.className = hidden ? 'fas fa-eye-slash' : 'far fa-eye';
            btn.title = hidden ? 'Show widget descriptions' : 'Hide widget descriptions';
            btn.classList.toggle('widget-info-toggle-on', hidden);
        }

        function toggleWidgetInfo() {
            localStorage.setItem('miniWidgetHideInfo', isWidgetInfoHidden() ? 'false' : 'true');
            if (typeof scheduleSettingsSave === 'function') scheduleSettingsSave();
            updateWidgetInfoToggleBtn();
            renderWidgetLibGrid();
            if (widgetDetailId) renderWidgetDetail();
        }

        // ── Search ────────────────────────────────────────────────────────────

        function widgetSearchNormalize(s) {
            return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        }

        // True when `needle` appears in `hay` as an in-order subsequence
        // (letters may be skipped in the haystack, not in the needle) — catches
        // minor typos of omission like "spotfy" → "spotify".
        function widgetFuzzySubsequence(needle, hay) {
            if (needle.length < 3 || needle.length > hay.length) return false;
            let i = 0;
            for (let j = 0; j < hay.length && i < needle.length; j++) {
                if (needle[i] === hay[j]) i++;
            }
            return i === needle.length;
        }

        // Scores widget `w` against the (already normalized) query.
        // Returns -1 when it doesn't match; higher scores sort earlier.
        // Every query token must hit at least one metadata field.
        function widgetSearchScore(w, query) {
            if (!query) return 0;
            const name = widgetSearchNormalize(w.label);
            const desc = widgetSearchNormalize(`${w.description} ${w.longDescription || ''}`);
            const cat = widgetSearchNormalize(w.category || '');
            const keywords = (w.keywords || []).map(widgetSearchNormalize);
            let score = 0;
            for (const token of query.split(' ')) {
                if (!token) continue;
                if (name.includes(token)) { score += name.startsWith(token) ? 120 : 100; continue; }
                if (keywords.some(k => k.includes(token))) { score += 80; continue; }
                if (cat.includes(token)) { score += 60; continue; }
                if (desc.includes(token)) { score += 40; continue; }
                if (widgetFuzzySubsequence(token, name) || keywords.some(k => widgetFuzzySubsequence(token, k))) {
                    score += 20;
                    continue;
                }
                return -1;
            }
            return score;
        }

        // Visible widgets for the current query + category, favourites first.
        function getVisibleWidgets() {
            const query = widgetSearchNormalize(widgetLibQuery);
            const favs = getWidgetFavs();
            return MINI_WIDGETS
                .map(w => ({ w, score: widgetSearchScore(w, query) }))
                .filter(x => x.score >= 0)
                .filter(x => widgetLibCategory === 'All' || (x.w.category || 'General') === widgetLibCategory)
                .sort((a, b) => {
                    const favA = favs.includes(a.w.id) ? 1 : 0;
                    const favB = favs.includes(b.w.id) ? 1 : 0;
                    if (favA !== favB) return favB - favA;
                    if (a.score !== b.score) return b.score - a.score;
                    return a.w.label.localeCompare(b.w.label);
                })
                .map(x => x.w);
        }

        // ── Open / close ──────────────────────────────────────────────────────

        function openWidgetLibrary(focusWidgetId) {
            try {
                const modal = document.getElementById('widget-library-modal');
                if (!modal) return;
                cancelModalClose(modal);
                widgetLibQuery = '';
                widgetLibSelIndex = -1;
                const search = document.getElementById('widget-lib-search');
                if (search) search.value = '';
                closeWidgetDetail(true);
                renderWidgetLibrary();
                modal.classList.remove('hidden');
                if (focusWidgetId && getMiniWidgetById(focusWidgetId)) {
                    openWidgetDetail(focusWidgetId);
                }
            } catch (e) {
                console.error('Widget Library: failed to open', e);
                showToast('Could not open Widget Library', true);
            }
        }

        function closeWidgetLibrary() {
            const modal = document.getElementById('widget-library-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            // A hotkey bind started from a widget detail panel disables all global
            // hotkeys — never leave it dangling when the library goes away.
            if (typeof bindingTarget !== 'undefined' && bindingTarget) cancelHotkeyBind();
            // Stop any Video Editor preview hosted in the detail panel — its audio
            // would otherwise keep playing from a hidden modal.
            if (typeof vePausePreview === 'function') vePausePreview();
            animateModalClose(modal, () => {
                modal.classList.add('hidden');
                closeWidgetDetail(true);
            });
        }

        function isWidgetLibraryOpen() {
            const modal = document.getElementById('widget-library-modal');
            return !!modal && !modal.classList.contains('hidden') && !modal.classList.contains('modal-closing');
        }

        // ── Rendering ─────────────────────────────────────────────────────────

        function renderWidgetLibrary() {
            updateWidgetInfoToggleBtn();
            renderWidgetLibCategories();
            renderWidgetLibGrid();
        }

        function renderWidgetLibCategories() {
            const bar = document.getElementById('widget-lib-categories');
            if (!bar) return;
            // Only offer chips for categories that actually contain widgets.
            const present = MINI_WIDGET_CATEGORIES.filter(c => MINI_WIDGETS.some(w => (w.category || 'General') === c));
            if (!present.includes(widgetLibCategory) && widgetLibCategory !== 'All') {
                widgetLibCategory = 'All';
                localStorage.setItem('widgetLibCategory', 'All');
            }
            bar.innerHTML = ['All', ...present].map(c => `
                <button type="button" class="widget-lib-chip${c === widgetLibCategory ? ' active' : ''}"
                    onclick="setWidgetLibCategory('${esc(c)}')">${esc(c)}</button>
            `).join('');
        }

        function setWidgetLibCategory(cat) {
            widgetLibCategory = cat;
            localStorage.setItem('widgetLibCategory', cat);
            widgetLibSelIndex = -1;
            renderWidgetLibCategories();
            renderWidgetLibGrid();
        }

        function widgetLibSearchInput(value) {
            widgetLibQuery = value;
            widgetLibSelIndex = -1;
            renderWidgetLibGrid();
        }

        function widgetStatusLine(w) {
            const enabled = isMiniWidgetEnabled(w.id);
            return `<span class="widget-status-dot${enabled ? ' on' : ''}"></span>${enabled ? 'Enabled' : 'Disabled'}`;
        }

        function renderWidgetLibGrid() {
            const grid = document.getElementById('widget-lib-grid');
            const empty = document.getElementById('widget-lib-empty');
            const count = document.getElementById('widget-lib-count');
            if (!grid) return;
            const visible = getVisibleWidgets();
            widgetLibVisibleIds = visible.map(w => w.id);
            const favs = getWidgetFavs();
            const recents = getWidgetRecents();
            const infoHidden = isWidgetInfoHidden();

            if (count) count.textContent = `${MINI_WIDGETS.length} widget${MINI_WIDGETS.length === 1 ? '' : 's'}`;
            if (empty) empty.classList.toggle('hidden', visible.length > 0);

            grid.innerHTML = visible.map((w, i) => {
                const fav = favs.includes(w.id);
                const enabled = isMiniWidgetEnabled(w.id);
                const recent = recents.includes(w.id);
                return `
                <div class="widget-lib-card${widgetLibSelIndex === i ? ' kb-selected' : ''}" data-wid="${w.id}"
                     style="animation-delay:${Math.min(i * 0.03, 0.24)}s"
                     onclick="openWidgetDetail('${w.id}')">
                    <div class="flex items-start justify-between gap-2">
                        <div class="widget-lib-card-icon"><i class="${w.iconStyle || 'fas'} ${w.icon}"></i></div>
                        <div class="flex items-center gap-1.5">
                            ${recent ? '<span class="widget-lib-recent-badge" title="Recently used"><i class="fas fa-clock-rotate-left"></i></span>' : ''}
                            <button type="button" class="widget-fav-btn${fav ? ' faved' : ''}" title="${fav ? 'Unfavourite' : 'Favourite'}"
                                onclick="event.stopPropagation(); toggleWidgetFavourite('${w.id}')">
                                <i class="${fav ? 'fas' : 'far'} fa-star"></i>
                            </button>
                        </div>
                    </div>
                    <div class="mt-2.5 min-w-0 flex-1">
                        <p class="text-sm font-medium text-white truncate">${esc(w.label)}</p>
                        ${infoHidden ? '' : `<p class="text-[11px] text-neutral-500 leading-snug mt-1 widget-lib-card-desc">${esc(w.description)}</p>`}
                    </div>
                    <div class="flex items-center justify-between mt-3 pt-2.5 border-t border-white/5">
                        <div class="flex items-center gap-1.5 text-[10px] text-neutral-500">
                            <span class="widget-lib-cat-tag">${esc(w.category || 'General')}</span>
                            <span class="text-neutral-600">v${esc(w.version || '1.0.0')}</span>
                        </div>
                        <span class="ios-toggle" onclick="event.stopPropagation()">
                            <input type="checkbox" class="ios-toggle-input" ${enabled ? 'checked' : ''}
                                onchange="setMiniWidgetEnabled('${w.id}', this.checked)">
                            <span class="ios-toggle-track"></span>
                        </span>
                    </div>
                </div>`;
            }).join('');
        }

        // ── Detail panel ──────────────────────────────────────────────────────

        // Pending hide timer from a non-instant close. Opening a detail (or
        // closing again) must cancel it — otherwise closing one widget and
        // quickly opening another within the 200ms exit window lets the stale
        // timer fire and wipe the freshly rendered detail.
        let widgetDetailHideTimer = null;

        function openWidgetDetail(id) {
            const w = getMiniWidgetById(id);
            const detail = document.getElementById('widget-detail');
            if (!w || !detail) return;
            if (widgetDetailHideTimer) {
                clearTimeout(widgetDetailHideTimer);
                widgetDetailHideTimer = null;
            }
            // Switching directly between two widgets: stop the previous widget's
            // Video Editor preview before its panel DOM is replaced.
            if (widgetDetailId && widgetDetailId !== id && typeof vePausePreview === 'function') vePausePreview();
            widgetDetailId = id;
            recordWidgetRecent(id);
            renderWidgetDetail();
            detail.classList.remove('hidden', 'detail-out');
            // Restart the slide-in on every open.
            detail.classList.remove('detail-in');
            void detail.offsetWidth;
            detail.classList.add('detail-in');
        }

        // `instant` skips animation/cleanup niceties (used while opening/closing the
        // whole library, when the detail is hidden with everything else anyway).
        function closeWidgetDetail(instant) {
            const detail = document.getElementById('widget-detail');
            if (!detail) return;
            if (!widgetDetailId && detail.classList.contains('hidden')) return;
            if (widgetDetailHideTimer) {
                clearTimeout(widgetDetailHideTimer);
                widgetDetailHideTimer = null;
            }
            if (typeof bindingTarget !== 'undefined' && bindingTarget) cancelHotkeyBind();
            if (typeof vePausePreview === 'function') vePausePreview();
            widgetDetailId = null;
            if (instant) {
                detail.classList.add('hidden');
                detail.classList.remove('detail-in', 'detail-out');
                detail.innerHTML = '';
                return;
            }
            detail.classList.remove('detail-in');
            detail.classList.add('detail-out');
            widgetDetailHideTimer = setTimeout(() => {
                widgetDetailHideTimer = null;
                detail.classList.remove('detail-out');
                detail.classList.add('hidden');
                detail.innerHTML = '';
                // The grid may have changed underneath (favourite/enable flips
                // reorder favourites-first) — refresh it on the way back.
                renderWidgetLibGrid();
            }, 200);
        }

        function renderWidgetDetail() {
            const w = getMiniWidgetById(widgetDetailId);
            const detail = document.getElementById('widget-detail');
            if (!w || !detail) return;
            const enabled = isMiniWidgetEnabled(w.id);
            const fav = isWidgetFav(w.id);
            const featureList = (w.features || []).map(f =>
                `<li class="flex items-start gap-2"><i class="fas fa-check text-[9px] mt-1 text-neutral-500"></i><span>${esc(f)}</span></li>`
            ).join('');

            detail.innerHTML = `
                <div class="flex items-center justify-between px-6 py-4 border-b border-white/10">
                    <button type="button" class="widget-detail-back no-drag" onclick="closeWidgetDetail()">
                        <i class="fas fa-arrow-left text-xs"></i><span>Library</span>
                    </button>
                    <button type="button" onclick="closeWidgetLibrary()" class="window-btn text-lg leading-none" title="Close">✕</button>
                </div>
                <div class="widget-detail-body flex-1 overflow-y-auto px-6 pt-5 pb-8">
                    <div class="flex items-start gap-4">
                        <div class="widget-detail-icon"><i class="${w.iconStyle || 'fas'} ${w.icon}"></i></div>
                        <div class="min-w-0 flex-1">
                            <h3 class="text-xl font-semibold text-white leading-tight">${esc(w.label)}</h3>
                            <div class="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px] text-neutral-500">
                                <span class="widget-lib-cat-tag">${esc(w.category || 'General')}</span>
                                <span>v${esc(w.version || '1.0.0')}</span>
                                <span>by ${esc(w.author || 'unknown')}</span>
                                <span id="widget-detail-status" class="flex items-center gap-1.5">${widgetStatusLine(w)}</span>
                            </div>
                        </div>
                        <button type="button" id="widget-detail-fav" class="widget-fav-btn widget-fav-btn-lg${fav ? ' faved' : ''}"
                            title="${fav ? 'Unfavourite' : 'Favourite'}"
                            onclick="toggleWidgetFavourite('${w.id}')">
                            <i class="${fav ? 'fas' : 'far'} fa-star"></i>
                        </button>
                    </div>
                    ${isWidgetInfoHidden() ? '' : `
                    <p class="text-sm text-neutral-400 leading-relaxed mt-4">${esc(w.longDescription || w.description)}</p>
                    ${featureList ? `
                    <h4 class="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mt-5 mb-2">Features</h4>
                    <ul class="text-xs text-neutral-400 space-y-1.5">${featureList}</ul>` : ''}`}
                    <div class="flex items-center gap-3 mt-6">
                        <button type="button" id="widget-detail-toggle-btn"
                            class="widget-detail-toggle${enabled ? ' on' : ''} no-drag"
                            onclick="setMiniWidgetEnabled('${w.id}', ${enabled ? 'false' : 'true'})">
                            ${enabled ? '<i class="fas fa-power-off mr-2"></i>Disable' : '<i class="fas fa-power-off mr-2"></i>Enable'}
                        </button>
                        ${w.defaultHotkey ? `
                        <div class="flex items-center gap-2 text-xs text-neutral-500">
                            <span>Hotkey</span>
                            <button type="button" id="${getHotkeyButtonId(w.id)}" class="hotkey-bind no-drag"
                                onclick="startHotkeyBind('${w.id}')"></button>
                        </div>` : ''}
                    </div>
                    ${w.panelId ? `<div id="${w.panelId}" class="${enabled ? '' : 'hidden'} mt-2"></div>` : ''}
                </div>
            `;
            updateHotkeyDisplays();
            renderWidgetConfigPanel(w);
        }

        // Fills the widget's config panel (if it has one) by calling the renderer
        // named in its registry entry. All panel renderers no-op when their div is
        // absent, so this is only needed when the detail panel is on screen.
        function renderWidgetConfigPanel(w) {
            if (!w || !w.panelId || !w.panelRenderer) return;
            const fn = window[w.panelRenderer];
            if (typeof fn === 'function') {
                try {
                    const result = fn();
                    if (result && typeof result.catch === 'function') {
                        result.catch(e => console.error(`Widget Library: ${w.panelRenderer} failed`, e));
                    }
                } catch (e) {
                    console.error(`Widget Library: ${w.panelRenderer} failed`, e);
                }
            } else {
                console.error(`Widget Library: missing panel renderer "${w.panelRenderer}" for widget "${w.id}"`);
            }
        }

        // ── Mutations ─────────────────────────────────────────────────────────

        async function setMiniWidgetEnabled(id, enabled) {
            const w = getMiniWidgetById(id);
            if (!w) return;
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            prefs[id] = !!enabled;
            localStorage.setItem('miniWidgetPrefs', JSON.stringify(prefs));
            if (enabled) recordWidgetRecent(id);
            scheduleSettingsSave();

            // Refresh whichever surfaces are on screen.
            if (widgetDetailId === id) {
                renderWidgetDetail();
            } else if (widgetDetailId === null && isWidgetLibraryOpen()) {
                // Only the card's own toggle changed — update its status without a
                // full grid re-render (no layout jump mid-interaction).
                const card = document.querySelector(`#widget-lib-grid .widget-lib-card[data-wid="${id}"]`);
                const cb = card && card.querySelector('.ios-toggle-input');
                if (cb) cb.checked = !!enabled;
            }
            renderMiniWidgetsStrip();
            if (typeof renderMiniWidgetsSettings === 'function') renderMiniWidgetsSettings();
            await applyMiniWidgetPrefs();
        }

        function toggleWidgetFavourite(id) {
            const w = getMiniWidgetById(id);
            if (!w) return;
            let favs = getWidgetFavs();
            const nowFav = !favs.includes(id);
            if (nowFav) favs.push(id);
            else favs = favs.filter(f => f !== id);
            localStorage.setItem('miniWidgetFavs', JSON.stringify(favs));
            scheduleSettingsSave();

            // Pop the star in place (grid card and/or detail header) rather than
            // re-rendering the grid mid-click — reordering happens on next render.
            document.querySelectorAll(`.widget-lib-card[data-wid="${id}"] .widget-fav-btn, #widget-detail-fav`).forEach(btn => {
                if (btn.id === 'widget-detail-fav' && widgetDetailId !== id) return;
                btn.classList.toggle('faved', nowFav);
                btn.title = nowFav ? 'Unfavourite' : 'Favourite';
                const icon = btn.querySelector('i');
                if (icon) icon.className = `${nowFav ? 'fas' : 'far'} fa-star`;
                btn.classList.remove('fav-pop');
                void btn.offsetWidth;
                btn.classList.add('fav-pop');
            });
            renderMiniWidgetsStrip();
            if (typeof renderMiniWidgetsSettings === 'function') renderMiniWidgetsSettings();
        }

        // ── Dashboard strip ───────────────────────────────────────────────────

        // The dashboard shows FAVOURITE widgets only — each as a small chip that
        // jumps straight to that widget in the library. Enabled-but-unfavourited
        // widgets keep working in the background; they just live in the library.
        function renderMiniWidgetsStrip() {
            const strip = document.getElementById('mini-widgets-strip');
            if (!strip) return;
            const favs = getWidgetFavs();
            const shown = MINI_WIDGETS
                .filter(w => favs.includes(w.id))
                .sort((a, b) => a.label.localeCompare(b.label));

            if (!shown.length) {
                strip.innerHTML = `<button type="button" class="mini-widget-chip mini-widget-chip-empty no-drag" onclick="openWidgetLibrary()">
                    <i class="far fa-star text-[9px]"></i><span>Favourite widgets in the Library to pin them here</span>
                </button>`;
                return;
            }
            strip.innerHTML = shown.map(w => `
                <button type="button" class="mini-widget-chip no-drag${isMiniWidgetEnabled(w.id) ? '' : ' chip-disabled'}"
                    onclick="openWidgetLibrary('${w.id}')"
                    title="${esc(w.description)}">
                    <i class="${w.iconStyle || 'fas'} ${w.icon} text-[10px]"></i>
                    <span>${esc(w.label)}</span>
                    <i class="fas fa-star text-[8px] mini-widget-chip-star"></i>
                </button>
            `).join('');
        }

        // ── Keyboard navigation ───────────────────────────────────────────────
        // Registered on capture BEFORE spotify-widget.js's global handler (script
        // order in main.html). Both listeners sit on `document` in the capture
        // phase, so claiming a key requires stopImmediatePropagation() —
        // stopPropagation() would NOT stop later listeners on the same node, and
        // Escape would fall through and close Settings/the app underneath.
        // Bails out instantly while a hotkey bind is in progress — those keys
        // belong to the binding handler.

        const WIDGET_LIB_GRID_COLS = 2; // keep in sync with .widget-lib-grid columns

        function widgetLibMoveSelection(delta) {
            if (!widgetLibVisibleIds.length) return;
            if (widgetLibSelIndex < 0) widgetLibSelIndex = 0;
            else widgetLibSelIndex = Math.max(0, Math.min(widgetLibVisibleIds.length - 1, widgetLibSelIndex + delta));
            document.querySelectorAll('#widget-lib-grid .widget-lib-card').forEach((card, i) => {
                card.classList.toggle('kb-selected', i === widgetLibSelIndex);
                if (i === widgetLibSelIndex) card.scrollIntoView({ block: 'nearest' });
            });
        }

        document.addEventListener('keydown', e => {
            if (!isWidgetLibraryOpen()) return;
            if (typeof bindingTarget !== 'undefined' && bindingTarget) return;

            const search = document.getElementById('widget-lib-search');
            const active = document.activeElement;
            const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
            const detailOpen = widgetDetailId !== null;

            // Close (Esc or the bound close hotkey): detail first, then the library.
            const isClose = e.key === 'Escape' ||
                (typeof keydownMatches === 'function' && keydownMatches(e, hotkeys.close));
            if (isClose) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.key === 'Escape' && active === search && search.value) {
                    search.value = '';
                    widgetLibSearchInput('');
                    return;
                }
                if (typing) active.blur();
                if (detailOpen) closeWidgetDetail();
                else closeWidgetLibrary();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (detailOpen) closeWidgetDetail();
                if (search) { search.focus(); search.select(); }
                return;
            }

            // Everything below is grid navigation — not while the detail panel is
            // open. Keys still get shielded from the Settings handler underneath,
            // but stay available to the detail's own inputs & config panels
            // (e.g. the Video Editor's Space shortcut handles itself).
            if (detailOpen) {
                if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.stopImmediatePropagation(); // keep it from Settings type-to-search
                }
                return;
            }

            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !typing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1
                    : e.key === 'ArrowUp' ? -WIDGET_LIB_GRID_COLS : WIDGET_LIB_GRID_COLS;
                widgetLibMoveSelection(delta);
                return;
            }

            if (e.key === 'Enter' && widgetLibSelIndex >= 0 && !typing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openWidgetDetail(widgetLibVisibleIds[widgetLibSelIndex]);
                return;
            }

            if (e.key === ' ' && widgetLibSelIndex >= 0 && !typing) {
                e.preventDefault();
                e.stopImmediatePropagation();
                toggleWidgetFavourite(widgetLibVisibleIds[widgetLibSelIndex]);
                return;
            }

            // Type-to-search: a plain character focuses the search box, and the
            // keystroke lands in it naturally.
            if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (search) search.focus();
                e.stopImmediatePropagation(); // keep it from Settings type-to-search
            }
        }, true);
