        // ── Clipboard History mini widget UI ──
        // Renders inside the #clipboard-panel container that renderMiniWidgetsSettings()
        // creates for the Clipboard registry entry. All persistence (polling, the
        // history file, pin/evict logic) lives in the main process (clipboard.js) --
        // this file is purely the management UI. Entries come in three types:
        // text snippets, images (rendered from an inline thumbnail), and copied
        // files (shown as a file-name list).

        let clipboardData = null; // last snapshot from clipboard-get / clipboard-changed
        const CLIPBOARD_PREVIEW_LEN = 160;
        const CLIPBOARD_MAX_FILE_NAMES = 3;

        async function refreshClipboardData() {
            if (!window.electronAPI?.clipboardGet) return;
            clipboardData = await window.electronAPI.clipboardGet();
        }

        function clipboardPreview(text) {
            const oneLine = text.replace(/\s+/g, ' ').trim();
            return oneLine.length > CLIPBOARD_PREVIEW_LEN
                ? `${oneLine.slice(0, CLIPBOARD_PREVIEW_LEN)}…`
                : oneLine;
        }

        function clipboardFileName(p) {
            const parts = p.split(/[\\/]/).filter(Boolean);
            return parts.length ? parts[parts.length - 1] : p;
        }

        function clipboardEntryBody(e) {
            const type = e.type || 'text';
            if (type === 'image') {
                return `<div class="flex-1 min-w-0 cursor-pointer" title="Click to copy image" onclick="clipboardCopyEntry('${e.id}')">
                    <img src="${e.thumb}" alt="Copied image" class="rounded-lg border border-white/10 max-h-24 max-w-full">
                    <p class="text-neutral-500 mt-1"><i class="fas fa-image mr-1.5"></i>Image · ${e.width}×${e.height}</p>
                </div>`;
            }
            if (type === 'files') {
                const names = e.files.slice(0, CLIPBOARD_MAX_FILE_NAMES).map(p =>
                    `<p class="text-neutral-300 break-words"><i class="fas fa-file mr-1.5 text-neutral-500"></i>${esc(clipboardFileName(p))}</p>`
                ).join('');
                const more = e.files.length > CLIPBOARD_MAX_FILE_NAMES
                    ? `<p class="text-neutral-500 mt-0.5">+${e.files.length - CLIPBOARD_MAX_FILE_NAMES} more</p>`
                    : '';
                return `<div class="flex-1 min-w-0 cursor-pointer" title="${esc(e.files.join('\n'))}&#10;Click to copy" onclick="clipboardCopyEntry('${e.id}')">${names}${more}</div>`;
            }
            return `<p class="text-neutral-300 flex-1 break-words cursor-pointer" title="Click to copy" onclick="clipboardCopyEntry('${e.id}')">${esc(clipboardPreview(e.text))}</p>`;
        }

        function clipboardEntryMeta(e) {
            const time = new Date(e.ts).toLocaleTimeString();
            if ((e.type || 'text') === 'files') {
                return `${e.files.length} file${e.files.length === 1 ? '' : 's'} · ${time}`;
            }
            return time;
        }

        async function renderClipboardPanel() {
            const panel = document.getElementById('clipboard-panel');
            if (!panel) return;
            await refreshClipboardData();
            if (!clipboardData) { panel.innerHTML = ''; return; }

            const d = clipboardData;
            let html = '';

            if (!d.enabled) {
                html += `<p class="text-xs text-neutral-600 mt-3 mb-2">Widget disabled — enable it above to start recording what you copy.</p>`;
            } else if (!d.history.length) {
                html += `<p class="text-xs text-neutral-600 mt-3 mb-2">Nothing copied yet. Copy text, an image, or files anywhere and they'll show up here.</p>`;
            }

            if (d.history.length) {
                html += `<div class="flex items-center justify-between gap-3 mt-3 mb-2">
                    <span class="text-xs text-neutral-500">${d.history.length} item${d.history.length === 1 ? '' : 's'}</span>
                    <button type="button" class="hotkey-bind no-drag" onclick="clipboardClearAll()">Clear</button>
                </div>`;

                // Pinned entries first (stable sort keeps each group's relative order).
                const sorted = [...d.history].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

                html += `<div class="space-y-2 max-h-72 overflow-y-auto pr-1">${sorted.map(e => `
                    <div class="border border-white/10 rounded-xl p-3 text-xs${e.pinned ? ' bg-white/5' : ''}">
                        <div class="flex items-start justify-between gap-2">
                            ${clipboardEntryBody(e)}
                            <div class="flex items-center gap-1 shrink-0">
                                <button type="button" title="Copy" onclick="clipboardCopyEntry('${e.id}')"
                                    class="w-6 h-6 flex items-center justify-center bg-neutral-800/30 hover:bg-neutral-700/50 border border-neutral-700/50 text-neutral-400 hover:text-neutral-200 rounded-lg transition-colors no-drag"><i class="fas fa-copy"></i></button>
                                <button type="button" title="${e.pinned ? 'Unpin' : 'Pin'}" onclick="clipboardTogglePinEntry('${e.id}')"
                                    class="w-6 h-6 flex items-center justify-center bg-neutral-800/30 hover:bg-neutral-700/50 border border-neutral-700/50 ${e.pinned ? 'text-amber-400' : 'text-neutral-400'} hover:text-amber-300 rounded-lg transition-colors no-drag"><i class="fas fa-thumbtack"></i></button>
                                <button type="button" title="Delete" onclick="clipboardDeleteEntry('${e.id}')"
                                    class="w-6 h-6 flex items-center justify-center bg-neutral-800/30 hover:bg-red-800/50 border border-neutral-700/50 hover:border-red-700/50 text-neutral-400 hover:text-red-400 rounded-lg transition-colors no-drag"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                        <p class="text-neutral-600 mt-1">${esc(clipboardEntryMeta(e))}</p>
                    </div>
                `).join('')}</div>`;
            }

            panel.innerHTML = html;
        }

        async function clipboardCopyEntry(id) {
            if (!window.electronAPI?.clipboardCopy) return;
            const res = await window.electronAPI.clipboardCopy(id);
            if (res && res.ok === false) {
                showToast(res.error || 'Copy failed');
            } else {
                showToast('Copied to clipboard');
            }
        }

        async function clipboardTogglePinEntry(id) {
            if (!window.electronAPI?.clipboardTogglePin) return;
            await window.electronAPI.clipboardTogglePin(id);
        }

        async function clipboardDeleteEntry(id) {
            if (!window.electronAPI?.clipboardDelete) return;
            await window.electronAPI.clipboardDelete(id);
        }

        async function clipboardClearAll() {
            if (!window.electronAPI?.clipboardClear) return;
            await window.electronAPI.clipboardClear();
            showToast('Clipboard history cleared');
        }

        // Live updates pushed from the main process (new snippet captured, pin
        // toggled, etc.) -- re-render immediately so the panel never shows stale data
        // while Settings is open.
        if (window.electronAPI?.onClipboardChanged) {
            window.electronAPI.onClipboardChanged((status) => {
                clipboardData = status;
                renderClipboardPanel();
            });
        }
