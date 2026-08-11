        // ── FPS OPTIMIZER ──
        let fpsActionInProgress = false;

        function openFpsOptimizer() {
            const mode = localStorage.getItem('fpsDisplayMode') || 'sidepanel';

            // Full window mode - launch standalone app
            if (mode === 'fullwindow') {
                if (window.electronAPI?.launchFPSOptimizer) {
                    window.electronAPI.launchFPSOptimizer();
                }
                return;
            }

            // Side panel mode - open modal
            const modal = document.getElementById('fps-modal');
            const content = document.getElementById('fps-content');
            const sidePanel = document.getElementById('fps-side-panel');

            cancelModalClose(modal);
            modal.classList.remove('hidden');
            document.getElementById('fps-progress-text').textContent = 'Ready';
            const fpsBar = document.getElementById('fps-progress-bar');
            fpsBar.style.width = '0%';
            fpsBar.classList.remove('is-complete');
            fpsActionInProgress = false;

            sidePanel.classList.remove('hidden');
            content.className = 'flex-1 flex overflow-hidden';
        }

        function closeFpsOptimizer() {
            animateModalClose(document.getElementById('fps-modal'));
            fpsActionInProgress = false;
            if (window.electronAPI?.removeFpsProgressListener) {
                window.electronAPI.removeFpsProgressListener();
            }
        }

        async function launchFpsAction(action) {
            if (fpsActionInProgress) return;
            if (!window.electronAPI) return;
            fpsActionInProgress = true;

            // Listen for progress updates. Drop any listener left by a previous action
            // first — each onFpsProgress call adds a NEW ipcRenderer listener, so without
            // this they pile up across runs within the same modal session.
            if (window.electronAPI.onFpsProgress) {
                window.electronAPI.removeFpsProgressListener?.();
                window.electronAPI.onFpsProgress((data) => {
                    const pct = Math.min(100, Math.round(data.pct * 100));
                    const bar = document.getElementById('fps-progress-bar');
                    bar.style.width = pct + '%';
                    // Freeze the travelling sheen once complete so the bar reads as "done".
                    bar.classList.toggle('is-complete', pct >= 100);
                    document.getElementById('fps-progress-text').textContent = data.msg || 'Processing...';
                });
            }

            try {
                if (action === 'optimize') {
                    await window.electronAPI.fpsOptimizeOnly();
                } else if (action === 'discord') {
                    await window.electronAPI.fpsDiscordOnly();
                } else if (action === 'nuke') {
                    await window.electronAPI.fpsNuke();
                } else if (action === 'battery') {
                    await window.electronAPI.fpsBatterySaver();
                } else if (action === 'revert') {
                    await window.electronAPI.fpsRevertOptimizations();
                }
                showToast('FPS optimization complete!');
            } catch (e) {
                showToast('FPS action failed', true);
                console.error(e);
            }

            fpsActionInProgress = false;
        }

