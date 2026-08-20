        // ── Shared macOS tool-install prompt ──
        // Some mac widgets (Bluetooth → blueutil, Screen Resolution →
        // displayplacer) rely on a tiny free Homebrew CLI. When a backend reports
        // `needsTool`, the panel shows this 1-click installer. Legal: it installs
        // the official, MIT-licensed tool via the user's Homebrew (installing
        // Homebrew itself opens its official installer in Terminal).

        function macToolMissingMarkup(tool, label, refreshFn) {
            const name = esc(label || tool);
            return `<div class="mt-3 rounded-xl border border-white/10 bg-neutral-800/20 p-4 text-center">
                <i class="fas fa-cube text-neutral-500 mb-2"></i>
                <p class="text-xs text-neutral-300">This uses <span class="text-white">${name}</span>, a small free tool that isn’t installed yet.</p>
                <p class="text-[10px] text-neutral-500 mt-1">Installs via Homebrew — if you don’t have it, its official installer opens first.</p>
                <button type="button" onclick="macToolInstall('${esc(tool)}', '${esc(refreshFn || '')}', this)"
                    class="mt-3 px-4 py-2 bg-white text-black rounded-xl text-xs font-medium no-drag hover:bg-neutral-200 transition-colors">
                    <i class="fas fa-download mr-1.5"></i>Install ${name}
                </button>
                <p id="mac-tool-msg-${esc(tool)}" class="mt-2 text-[11px] text-neutral-500"></p>
            </div>`;
        }

        async function macToolInstall(tool, refreshFn, btn) {
            const msg = document.getElementById('mac-tool-msg-' + tool);
            if (btn) btn.disabled = true;
            if (msg) msg.textContent = 'Installing… this can take a minute.';
            try {
                const r = await window.electronAPI.macToolsInstall(tool);
                if (r && r.ok) {
                    if (msg) msg.textContent = 'Installed!';
                    if (refreshFn && typeof window[refreshFn] === 'function') window[refreshFn]();
                } else if (r && r.needsBrew) {
                    // Homebrew (the macOS package manager) is required first; its
                    // official installer was just opened in Terminal.
                    if (msg) msg.textContent = 'This needs Homebrew (the macOS package manager) first — its official installer just opened in Terminal. Finish it there (it may ask for your password), then click Install again.';
                    if (btn) btn.disabled = false;
                } else if (r && r.opened) {
                    if (msg) msg.textContent = 'Finish the install in the Terminal window that opened, then come back and retry.';
                    if (btn) btn.disabled = false;
                } else {
                    if (msg) msg.textContent = (r && r.error) || 'Install failed.';
                    if (btn) btn.disabled = false;
                }
            } catch (e) {
                if (msg) msg.textContent = 'Install failed.';
                if (btn) btn.disabled = false;
            }
        }
