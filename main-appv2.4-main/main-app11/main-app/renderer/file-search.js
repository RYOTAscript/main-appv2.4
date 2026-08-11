        // ── File Search mini widget (voidtools "Everything"-style) ──
        // Instant filename search over the folders the user indexes. The heavy
        // lifting (the directory walk + in-memory index + query engine) lives in the
        // main process (main/fileSearch.js); this file is the panel UI: a search box
        // that queries on every keystroke, a streaming index-build progress bar, root
        // management, and per-result actions (open / open folder / copy path).
        //
        // The panel div only exists while the Widget Library detail is open, so every
        // entry point here no-ops when it's absent (per the mini-widget contract).

        let fsResults = [];
        let fsMeta = { total: 0, returned: 0, tookMs: 0, indexed: 0, needsIndex: false, indexTruncated: false };
        let fsIndexStatus = null;
        let fsQuery = '';
        let fsSortBy = 'relevance';
        let fsSortDir = 'desc';
        let fsBuilding = false;
        let fsProgress = null;
        let fsQueryTimer = null;
        let fsProgressHooked = false;
        let fsShowSettings = false;

        function isFileSearchEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.fileSearch;
        }

        function fsFmtSize(bytes, isDir) {
            if (isDir) return '';
            if (bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0, n = bytes;
            while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
            return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
        }

        function fsFmtDate(ms) {
            if (!ms) return '';
            const d = new Date(ms);
            if (isNaN(d.getTime())) return '';
            const diff = Date.now() - ms;
            if (diff >= 0 && diff < 86400000) {
                const h = Math.floor(diff / 3600000);
                if (h < 1) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
                return `${h}h ago`;
            }
            return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function fsFmtBuiltAt(ms) {
            if (!ms) return 'never';
            const d = new Date(ms);
            if (isNaN(d.getTime())) return 'never';
            return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        function fsFileIcon(ext, isDir) {
            if (isDir) return 'fa-folder';
            const e = (ext || '').toLowerCase();
            if (/^(mp4|mkv|mov|avi|webm|flv|wmv|m4v)$/.test(e)) return 'fa-file-video';
            if (/^(mp3|wav|flac|aac|ogg|m4a|wma)$/.test(e)) return 'fa-file-audio';
            if (/^(png|jpg|jpeg|gif|webp|bmp|svg|tiff|ico|heic)$/.test(e)) return 'fa-file-image';
            if (/^(zip|rar|7z|tar|gz|xz|bz2)$/.test(e)) return 'fa-file-zipper';
            if (/^(pdf)$/.test(e)) return 'fa-file-pdf';
            if (/^(doc|docx|odt|rtf)$/.test(e)) return 'fa-file-word';
            if (/^(xls|xlsx|csv|ods)$/.test(e)) return 'fa-file-excel';
            if (/^(ppt|pptx|odp)$/.test(e)) return 'fa-file-powerpoint';
            if (/^(txt|md|log|ini|cfg|json|yaml|yml|xml)$/.test(e)) return 'fa-file-lines';
            if (/^(js|ts|jsx|tsx|py|java|c|cpp|cs|go|rs|rb|php|html|css|sh|ps1|lua)$/.test(e)) return 'fa-file-code';
            if (/^(exe|msi|bat|cmd|com)$/.test(e)) return 'fa-gear';
            return 'fa-file';
        }

        async function fsRefreshStatus() {
            if (!window.electronAPI?.fileSearchIndexStatus) return;
            fsIndexStatus = await window.electronAPI.fileSearchIndexStatus();
            fsBuilding = !!fsIndexStatus?.building;
        }

        // Builds the whole panel shell. Re-runs the current query into the results
        // sub-container afterwards so state survives the detail being reopened.
        async function renderFileSearchPanel() {
            const panel = document.getElementById('file-search-panel');
            if (!panel) return;
            if (!isFileSearchEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.fileSearchQuery) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">File search is unavailable.</p>`;
                return;
            }

            if (!fsProgressHooked && window.electronAPI.onFileSearchIndexProgress) {
                window.electronAPI.onFileSearchIndexProgress(fsOnIndexProgress);
                fsProgressHooked = true;
            }

            await fsRefreshStatus();

            panel.innerHTML = `
                <div class="fs-root mt-3">
                    <div class="fs-searchbar">
                        <i class="fas fa-magnifying-glass fs-search-icon"></i>
                        <input type="text" id="fs-input" class="no-drag" spellcheck="false" autocomplete="off"
                            placeholder="Search files…  (try *.mp4, ext:png, size:>10mb)" value="${esc(fsQuery)}"
                            oninput="fsOnInput(this.value)" onkeydown="fsOnKeyDown(event)">
                        ${fsQuery ? `<button type="button" class="fs-clear no-drag" onclick="fsClearQuery()" title="Clear"><i class="fas fa-xmark"></i></button>` : ''}
                    </div>
                    <div id="fs-statusbar" class="fs-statusbar">${fsStatusBarHtml()}</div>
                    <div id="fs-settings">${fsShowSettings ? fsSettingsHtml() : ''}</div>
                    <div id="fs-results" class="fs-results">${fsResultsHtml()}</div>
                </div>`;

            const input = document.getElementById('fs-input');
            if (input && fsQuery) { input.focus(); const v = input.value; input.value = ''; input.value = v; }

            // Reopening the detail rebuilds the shell — refresh results for any query
            // that was still in the box so they reflect the current index.
            if (fsQuery.trim()) fsRunQuery();
        }

        function fsStatusBarHtml() {
            const idx = fsIndexStatus || {};
            const count = idx.count || 0;
            if (fsBuilding) {
                const p = fsProgress || {};
                // The total file count is unknowable until the walk finishes, so this
                // is a true indeterminate load — an animated sweep bar plus the live
                // running count (which IS accurate) reads better than a fake percentage.
                return `<div class="fs-status-line">
                        <span class="fs-status-left"><span class="load-ring mr-2 text-blue-400"></span>Indexing… ${(p.count || 0).toLocaleString()} items</span>
                        <button type="button" class="fs-btn fs-btn-danger no-drag" onclick="fsCancelIndex()"><i class="fas fa-stop mr-1"></i>Stop</button>
                    </div>
                    <div class="load-bar" style="margin:8px 0;"></div>
                    <p class="fs-status-sub truncate">${esc((fsProgress && fsProgress.currentDir) || 'Scanning…')}</p>`;
            }
            const built = count > 0
                ? `<span class="fs-status-left"><i class="fas fa-database mr-1.5 text-neutral-500"></i>${count.toLocaleString()} indexed${idx.truncated ? ' (capped)' : ''} · ${fsFmtBuiltAt(idx.builtAt)}</span>`
                : `<span class="fs-status-left text-amber-400"><i class="fas fa-triangle-exclamation mr-1.5"></i>No index yet — build one to search</span>`;
            return `<div class="fs-status-line">
                    ${built}
                    <div class="flex items-center gap-1.5">
                        <button type="button" class="fs-btn no-drag ${fsShowSettings ? 'fs-btn-active' : ''}" onclick="fsToggleSettings()" title="Folders & options"><i class="fas fa-sliders"></i></button>
                        <button type="button" class="fs-btn fs-btn-primary no-drag" onclick="fsBuildIndex()"><i class="fas fa-rotate mr-1"></i>${count > 0 ? 'Rebuild' : 'Build index'}</button>
                    </div>
                </div>`;
        }

        function fsSettingsHtml() {
            const idx = fsIndexStatus || {};
            const roots = idx.roots || [];
            const rootChips = roots.map((r, i) => `
                <span class="fs-chip">
                    <i class="fas fa-folder-open text-[10px] text-neutral-500"></i>
                    <span class="truncate" title="${esc(r)}">${esc(r)}</span>
                    <button type="button" class="fs-chip-x no-drag" title="Remove" onclick="fsRemoveRootByIndex(${i})"><i class="fas fa-xmark"></i></button>
                </span>`).join('');
            return `<div class="fs-settings">
                    <p class="fs-settings-label">Indexed folders</p>
                    <div class="fs-chips">${rootChips || '<span class="text-[11px] text-neutral-600">No folders — add one below.</span>'}</div>
                    <div class="flex items-center gap-1.5 mt-2 flex-wrap">
                        <button type="button" class="fs-btn no-drag" onclick="fsPickFolder()"><i class="fas fa-folder-plus mr-1"></i>Add folder</button>
                        <button type="button" class="fs-btn no-drag" onclick="fsAddDrives()"><i class="fas fa-hard-drive mr-1"></i>Add a drive</button>
                    </div>
                    <label class="fs-check mt-3"><input type="checkbox" id="fs-hidden" ${idx.__includeHidden ? 'checked' : ''} onchange="fsSetHidden(this.checked)"><span>Include hidden / system files</span></label>
                    <p class="fs-status-sub mt-2">After changing folders, click <b>Rebuild</b> to refresh the index.</p>
                </div>`;
        }

        function fsResultsHtml() {
            if (fsMeta.needsIndex) {
                return `<div class="fs-empty"><i class="fas fa-database"></i><p>Build an index of your folders to start searching.</p></div>`;
            }
            if (!fsQuery.trim()) {
                return `<div class="fs-empty"><i class="fas fa-keyboard"></i><p>Start typing to search your files.</p>
                    <p class="fs-hint">Wildcards <code>*</code> <code>?</code> · <code>ext:mp4,png</code> · <code>size:&gt;10mb</code> · <code>folder:</code> · <code>path:</code> · <code>regex:</code></p></div>`;
            }
            if (!fsResults.length) {
                return `<div class="fs-empty"><i class="fas fa-file-circle-xmark"></i><p>No files match “${esc(fsQuery)}”.</p></div>`;
            }
            const header = `<div class="fs-results-head">
                    <span>${fsMeta.total.toLocaleString()} match${fsMeta.total === 1 ? '' : 'es'}${fsMeta.returned < fsMeta.total ? ` · showing ${fsMeta.returned}` : ''} · ${fsMeta.tookMs}ms</span>
                    <span class="fs-sort">
                        ${fsSortBtn('relevance', 'Best')}
                        ${fsSortBtn('name', 'Name')}
                        ${fsSortBtn('size', 'Size')}
                        ${fsSortBtn('modified', 'Date')}
                    </span>
                </div>`;
            const rows = fsResults.map((r, i) => {
                const meta = [];
                if (r.dir) meta.push('Folder');
                else { meta.push(r.ext ? r.ext.toUpperCase() : 'File'); const s = fsFmtSize(r.size, r.dir); if (s) meta.push(s); }
                const dt = fsFmtDate(r.mtime); if (dt) meta.push(dt);
                const dir = r.path.slice(0, Math.max(0, r.path.length - r.name.length)).replace(/[\\/]$/, '');
                // Actions pass the row INDEX, never the path — so a filename/path with
                // quotes or backslashes can never break out of the inline handler.
                return `<div class="fs-row" data-i="${i}" ondblclick="fsRowOpen(${i})">
                        <span class="fs-row-icon"><i class="fas ${fsFileIcon(r.ext, r.dir)}"></i></span>
                        <div class="min-w-0 flex-1">
                            <p class="fs-row-name truncate" title="${esc(r.name)}">${esc(r.name)}</p>
                            <p class="fs-row-path truncate" title="${esc(dir)}">${esc(dir)}</p>
                        </div>
                        <span class="fs-row-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</span>
                        <span class="fs-row-actions">
                            <button type="button" class="fs-iconbtn no-drag" title="Open" onclick="fsRowOpen(${i})"><i class="fas fa-up-right-from-square text-[10px]"></i></button>
                            <button type="button" class="fs-iconbtn no-drag" title="Open folder" onclick="fsRowReveal(${i})"><i class="fas fa-folder-open text-[10px]"></i></button>
                            <button type="button" class="fs-iconbtn no-drag" title="Copy path" onclick="fsRowCopy(${i})"><i class="fas fa-copy text-[10px]"></i></button>
                        </span>
                    </div>`;
            }).join('');
            return header + `<div class="fs-rows">${rows}</div>`;
        }

        function fsSortBtn(key, label) {
            const active = fsSortBy === key;
            const arrow = active ? (fsSortDir === 'asc' ? ' <i class="fas fa-arrow-up-short-wide text-[9px]"></i>' : ' <i class="fas fa-arrow-down-wide-short text-[9px]"></i>') : '';
            return `<button type="button" class="fs-sort-btn no-drag ${active ? 'fs-sort-active' : ''}" onclick="fsSetSort('${key}')">${label}${arrow}</button>`;
        }

        function fsPaintStatus() {
            const el = document.getElementById('fs-statusbar');
            if (el) el.innerHTML = fsStatusBarHtml();
        }
        function fsPaintResults() {
            const el = document.getElementById('fs-results');
            if (el) el.innerHTML = fsResultsHtml();
        }
        function fsPaintSettings() {
            const el = document.getElementById('fs-settings');
            if (el) el.innerHTML = fsShowSettings ? fsSettingsHtml() : '';
        }

        // ── Query ──

        function fsOnInput(value) {
            fsQuery = value;
            const clearBtn = document.querySelector('.fs-searchbar .fs-clear');
            if (!!value !== !!clearBtn) {
                // Toggle the clear button without rebuilding the input (keeps focus).
                const bar = document.querySelector('.fs-searchbar');
                if (bar) {
                    const existing = bar.querySelector('.fs-clear');
                    if (value && !existing) {
                        const b = document.createElement('button');
                        b.type = 'button'; b.className = 'fs-clear no-drag'; b.title = 'Clear';
                        b.innerHTML = '<i class="fas fa-xmark"></i>';
                        b.onclick = fsClearQuery;
                        bar.appendChild(b);
                    } else if (!value && existing) {
                        existing.remove();
                    }
                }
            }
            if (fsQueryTimer) clearTimeout(fsQueryTimer);
            fsQueryTimer = setTimeout(fsRunQuery, 110);
        }

        function fsClearQuery() {
            fsQuery = '';
            const input = document.getElementById('fs-input');
            if (input) { input.value = ''; input.focus(); }
            const bar = document.querySelector('.fs-searchbar .fs-clear');
            if (bar) bar.remove();
            fsRunQuery();
        }

        async function fsRunQuery() {
            if (!window.electronAPI?.fileSearchQuery) return;
            const q = fsQuery;
            const res = await window.electronAPI.fileSearchQuery(q, { sortBy: fsSortBy, sortDir: fsSortDir, limit: 500 });
            // Ignore a stale response if the user has since changed the query.
            if (q !== fsQuery) return;
            if (res?.ok) {
                fsResults = res.results || [];
                fsMeta = {
                    total: res.total || 0, returned: res.returned || 0, tookMs: res.tookMs || 0,
                    indexed: res.indexed || 0, needsIndex: !!res.needsIndex, indexTruncated: !!res.indexTruncated
                };
            } else {
                fsResults = []; fsMeta = { total: 0, returned: 0, tookMs: 0, indexed: 0, needsIndex: false, indexTruncated: false };
            }
            fsPaintResults();
        }

        function fsSetSort(key) {
            if (fsSortBy === key) {
                fsSortDir = fsSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                fsSortBy = key;
                fsSortDir = (key === 'name') ? 'asc' : 'desc';
            }
            fsRunQuery();
        }

        function fsOnKeyDown(e) {
            if (e.key === 'Enter' && fsResults.length) {
                const first = fsResults[0];
                if (first) fsOpen(first.path);
            } else if (e.key === 'Escape' && fsQuery) {
                e.stopPropagation();
                fsClearQuery();
            }
        }

        // ── Index build ──

        async function fsBuildIndex() {
            if (!window.electronAPI?.fileSearchBuildIndex || fsBuilding) return;
            fsBuilding = true;
            fsProgress = { count: 0 };
            fsPaintStatus();
            showToast('Building file index…');
            try {
                const res = await window.electronAPI.fileSearchBuildIndex();
                if (res?.status) fsIndexStatus = res.status;
                fsBuilding = false;
                if (res?.ok) {
                    showToast(`Indexed ${(res.count || 0).toLocaleString()} items${res.truncated ? ' (cap reached)' : ''}`);
                    fsMeta.needsIndex = false;
                    fsRunQuery();
                } else if (res?.error === 'no-valid-roots') {
                    showToast('Add a folder to index first', true);
                    fsShowSettings = true; fsPaintSettings();
                } else if (res?.error !== 'cancelled') {
                    showToast('Index build failed', true);
                }
            } catch (e) {
                fsBuilding = false;
                showToast('Index build failed', true);
            }
            fsPaintStatus();
        }

        async function fsCancelIndex() {
            if (!window.electronAPI?.fileSearchCancelIndex) return;
            await window.electronAPI.fileSearchCancelIndex();
            showToast('Stopping index…');
        }

        function fsOnIndexProgress(data) {
            if (!data) return;
            if (data.building) {
                fsBuilding = true;
                fsProgress = data;
            } else {
                fsBuilding = false;
                if (data.count !== undefined && fsIndexStatus) fsIndexStatus.count = data.count;
            }
            // Only repaint if our panel is actually on screen.
            if (document.getElementById('fs-statusbar')) fsPaintStatus();
        }

        // ── Roots / config ──

        async function fsToggleSettings() {
            fsShowSettings = !fsShowSettings;
            // Pull the real config the first time the pane opens so the "include
            // hidden" checkbox reflects the saved value (the status payload omits it).
            if (fsShowSettings && fsIndexStatus && fsIndexStatus.__includeHidden === undefined && window.electronAPI?.fileSearchGetConfig) {
                try {
                    const cfg = await window.electronAPI.fileSearchGetConfig();
                    fsIndexStatus.__includeHidden = !!cfg?.includeHidden;
                } catch (e) { /* leave unchecked */ }
            }
            fsPaintSettings();
            fsPaintStatus();
        }

        async function fsPickFolder() {
            if (!window.electronAPI?.fileSearchPickFolder) return;
            const res = await window.electronAPI.fileSearchPickFolder();
            if (res?.roots && fsIndexStatus) { fsIndexStatus.roots = res.roots; fsPaintSettings(); }
            if (res?.ok) showToast('Folder added — click Rebuild to index it');
        }

        async function fsAddDrives() {
            if (!window.electronAPI?.fileSearchListDrives) return;
            const res = await window.electronAPI.fileSearchListDrives();
            const drives = res?.drives || [];
            if (!drives.length) { showToast('No drives found', true); return; }
            // Add every drive not already indexed.
            const have = new Set((fsIndexStatus?.roots || []).map((r) => r.toLowerCase()));
            let added = 0;
            for (const d of drives) {
                if (have.has(d.toLowerCase())) continue;
                const r = await window.electronAPI.fileSearchAddRoot(d);
                if (r?.ok) { added++; if (fsIndexStatus) fsIndexStatus.roots = r.roots; }
            }
            fsPaintSettings();
            showToast(added ? `Added ${added} drive${added === 1 ? '' : 's'} — click Rebuild` : 'All drives already added');
        }

        async function fsRemoveRoot(pathStr) {
            if (!window.electronAPI?.fileSearchRemoveRoot) return;
            const res = await window.electronAPI.fileSearchRemoveRoot(pathStr);
            if (res?.roots && fsIndexStatus) { fsIndexStatus.roots = res.roots; fsPaintSettings(); }
        }

        async function fsSetHidden(checked) {
            if (!window.electronAPI?.fileSearchSetConfig) return;
            await window.electronAPI.fileSearchSetConfig({ includeHidden: !!checked });
            if (fsIndexStatus) fsIndexStatus.__includeHidden = !!checked;
            showToast('Rebuild to apply the change');
        }

        // ── Result actions ──
        // Index-based wrappers used by the row buttons so no path is ever embedded
        // in an inline handler (see fsResultsHtml).
        function fsRowOpen(i) { const r = fsResults[i]; if (r) fsOpen(r.path); }
        function fsRowReveal(i) { const r = fsResults[i]; if (r) fsReveal(r.path); }
        function fsRowCopy(i) { const r = fsResults[i]; if (r) fsCopyPath(r.path); }
        function fsRemoveRootByIndex(i) {
            const roots = (fsIndexStatus && fsIndexStatus.roots) || [];
            if (roots[i]) fsRemoveRoot(roots[i]);
        }

        async function fsOpen(pathStr) {
            if (!window.electronAPI?.fileSearchOpen) return;
            const res = await window.electronAPI.fileSearchOpen(pathStr);
            if (res && !res.ok) showToast(res.error === 'Not found' ? 'File no longer exists' : 'Could not open', true);
        }

        async function fsReveal(pathStr) {
            if (!window.electronAPI?.fileSearchReveal) return;
            const res = await window.electronAPI.fileSearchReveal(pathStr);
            if (res && !res.ok) showToast('Could not open folder', true);
        }

        async function fsCopyPath(pathStr) {
            try {
                await navigator.clipboard.writeText(pathStr);
                showToast('Path copied');
            } catch (e) {
                // Fallback for environments where the async clipboard API is blocked.
                try {
                    const ta = document.createElement('textarea');
                    ta.value = pathStr; ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
                    showToast('Path copied');
                } catch (e2) {
                    showToast('Could not copy path', true);
                }
            }
        }

