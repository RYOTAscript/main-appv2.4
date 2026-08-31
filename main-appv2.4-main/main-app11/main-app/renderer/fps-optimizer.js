        // ── FPS Optimizer mini widget ──
        // The former standalone FPS Optimizer app, folded into a Widget Library
        // panel that matches the rest of the launcher. Six tabs (Boost, Power,
        // Memory, Network, Battery, Restore) each list one-click actions; a shared
        // progress bar reflects live per-step progress streamed from the backend
        // ('fps-progress'). All privileged work lives in main/fpsOptimizer.js — this
        // file is only UI. The panel div exists solely while the Widget Library
        // detail is open, so every entry point no-ops when it's absent.

        // Each action either calls a batch preload method (`method`) or a single
        // granular tweak by key (`action` → window.electronAPI.fpsAction). `tone`
        // drives the button colour: primary (accent), warn (amber), danger (red).
        const FPS_TABS = [
            {
                id: 'boost', label: 'Boost', icon: 'fa-bolt',
                actions: [
                    { title: 'Optimize', desc: 'Run every performance tweak: power plan, CPU priority, RAM purge, temp cleanup, network + Game Mode.', method: 'fpsOptimizeOnly', tone: 'primary', btn: 'Run' },
                    { title: 'Discord Only', desc: 'Free resources by closing background apps — keeps Discord, Valorant, Riot and system processes.', method: 'fpsDiscordOnly', tone: 'warn', btn: 'Run' },
                    { title: 'Kill Everything', desc: 'Terminate every non-system app, including Discord. The launcher and Windows stay protected.', method: 'fpsNuke', tone: 'danger', btn: 'Run' }
                ]
            },
            {
                id: 'power', label: 'Power', icon: 'fa-plug',
                actions: [
                    { title: 'Ultimate Performance', desc: 'Unlock and activate the hidden Windows Ultimate Performance plan.', action: 'ultimate', tone: 'primary', btn: 'Run' },
                    { title: 'High Performance', desc: 'Switch to the standard High Performance power plan.', action: 'high', tone: 'default', btn: 'Run' },
                    { title: 'Balanced', desc: 'Return to the Balanced plan — good for everyday use.', action: 'balanced', tone: 'default', btn: 'Run' },
                    { title: 'CPU → Game Priority', desc: 'GPU priority 8 + High scheduling category so games get the CPU first.', action: 'cpuPriority', tone: 'warn', btn: 'Run' },
                    { title: 'Enable HAGS', desc: 'Hardware-Accelerated GPU Scheduling — needs a reboot to take effect.', action: 'hags', tone: 'primary', btn: 'Run' }
                ]
            },
            {
                id: 'memory', label: 'Memory', icon: 'fa-memory',
                actions: [
                    { title: 'Release Standby RAM', desc: 'Trim every process working set to flush the standby list back to free memory.', action: 'clearStandby', tone: 'primary', btn: 'Run' },
                    { title: 'Clear Temp Files', desc: 'Wipe %TEMP% and C:\\Windows\\Temp of leftover junk.', action: 'clearTemp', tone: 'default', btn: 'Run' },
                    { title: 'Disable Superfetch', desc: 'Stop SysMain — can reduce SSD stutter and disk thrash.', action: 'disableSuperfetch', tone: 'default', btn: 'Run' },
                    { title: 'Re-enable Superfetch', desc: 'Restart the SysMain service.', action: 'enableSuperfetch', tone: 'default', btn: 'Run' }
                ]
            },
            {
                id: 'network', label: 'Network', icon: 'fa-wifi',
                actions: [
                    { title: 'Flush DNS Cache', desc: 'Clear the resolver cache — fixes stale-DNS lag spikes.', action: 'flushDns', tone: 'primary', btn: 'Run' },
                    { title: 'Low-Latency Network', desc: 'Raise the network throttling index for lower latency under load.', action: 'lowLatency', tone: 'warn', btn: 'Run' },
                    { title: 'Reset Network Tweaks', desc: 'Revert the throttling change back to the Windows default.', action: 'resetNetwork', tone: 'default', btn: 'Run' }
                ]
            },
            {
                id: 'battery', label: 'Battery', icon: 'fa-battery-half',
                actions: [
                    { title: 'Battery Saver', desc: 'Throttle CPU to 50%, stop background services, disable Bluetooth and close non-essential apps.', method: 'fpsBatterySaver', tone: 'primary', btn: 'Activate' },
                    { title: 'Restore Defaults', desc: 'Undo the tweaks and bring Windows back to its normal state.', method: 'fpsRevertOptimizations', tone: 'default', btn: 'Revert' }
                ]
            },
            {
                id: 'restore', label: 'Restore', icon: 'fa-rotate-left',
                actions: [
                    { title: 'Restore All Defaults', desc: 'Reverse every optimization: power plan, CPU scheduling, Superfetch, network, telemetry, background apps, Search Indexer.', method: 'fpsRevertOptimizations', tone: 'primary', btn: 'Run' },
                    { title: 'Balanced Power Plan', desc: 'Switch back to the Balanced power plan.', action: 'balanced', tone: 'default', btn: 'Run' },
                    { title: 'Re-enable Superfetch', desc: 'Restart the SysMain service.', action: 'enableSuperfetch', tone: 'default', btn: 'Run' },
                    { title: 'Re-enable Search Indexer', desc: 'Restart the WSearch service.', action: 'enableSearch', tone: 'default', btn: 'Run' },
                    { title: 'Restore Telemetry Default', desc: 'Remove the telemetry policy override.', action: 'restoreTelemetry', tone: 'default', btn: 'Run' },
                    { title: 'Restore Background Apps', desc: 'Re-allow background apps for your account.', action: 'restoreBackgroundApps', tone: 'default', btn: 'Run' }
                ]
            }
        ];

        // Actions that touch HKLM / Windows services / powercfg / other processes'
        // working sets need administrator rights. When the app isn't elevated we
        // show the Windows UAC prompt and, on accept, relaunch the WHOLE app as
        // admin so these just work (see main/elevate.js). Everything not listed
        // here is HKCU / user-temp / process-kill work that runs fine unelevated.
        const FPS_ADMIN_METHODS = new Set(['fpsOptimizeOnly', 'fpsBatterySaver', 'fpsRevertOptimizations']);
        const FPS_ADMIN_ACTIONS = new Set([
            'ultimate', 'high', 'balanced', 'cpuPriority', 'hags',
            'clearStandby', 'disableSuperfetch', 'enableSuperfetch',
            'lowLatency', 'resetNetwork', 'enableSearch', 'restoreTelemetry'
        ]);
        function fpsActionNeedsAdmin(a) {
            return a.method ? FPS_ADMIN_METHODS.has(a.method) : FPS_ADMIN_ACTIONS.has(a.action);
        }

        let fpsTab = 'boost';        // active tab id
        let fpsBusy = false;         // an action is mid-run (locks the panel)
        let fpsProgressHooked = false;

        function isFpsOptimizerEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.fpsOptimizer;
        }

        // Live progress from the backend. Looks elements up by id each tick so it is
        // safe whether or not the panel is currently mounted.
        function fpsOnProgress(data) {
            const pct = Math.min(100, Math.round((data.pct || 0) * 100));
            const fill = document.getElementById('fps-pr-fill');
            const pctEl = document.getElementById('fps-pr-pct');
            const label = document.getElementById('fps-pr-label');
            if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('is-complete', pct >= 100); }
            if (pctEl) pctEl.textContent = pct + '%';
            if (label) label.textContent = data.msg || 'Working…';
        }

        function renderFpsOptimizerPanel() {
            const panel = document.getElementById('fps-optimizer-panel');
            if (!panel) return;
            if (!isFpsOptimizerEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.fpsOptimizeOnly) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">FPS Optimizer is unavailable.</p>`;
                return;
            }

            if (!fpsProgressHooked && window.electronAPI.onFpsProgress) {
                window.electronAPI.onFpsProgress(fpsOnProgress);
                fpsProgressHooked = true;
            }

            panel.innerHTML = `<div class="fps-root mt-3">${fpsBodyHtml()}</div>`;
        }

        function fpsBodyHtml() {
            return `
                ${fpsProgressHtml()}
                ${fpsTabsHtml()}
                <div class="fps-tabbody ${fpsBusy ? 'fps-locked' : ''}">${fpsActionsHtml()}</div>
                <p class="fps-eula">Actions use Windows' own tools. System tweaks (power plans, services, HKLM) need administrator rights — main will ask to restart as admin the first time you run one. Process kills always protect Windows and the launcher itself; tweaks are reversible from the Restore tab.</p>`;
        }

        function fpsProgressHtml() {
            return `
                <div class="fps-progress">
                    <div class="fps-pr-head">
                        <span id="fps-pr-label" class="fps-pr-name">Ready</span>
                        <span id="fps-pr-pct" class="fps-pr-pct">0%</span>
                    </div>
                    <div class="fps-pr-bar"><div id="fps-pr-fill" class="fps-pr-fill" style="width:0%"></div></div>
                </div>`;
        }

        function fpsTabsHtml() {
            return `<div class="fps-tabs">${FPS_TABS.map((t) => `
                <button type="button" class="fps-tab no-drag ${fpsTab === t.id ? 'fps-tab-on' : ''}" onclick="fpsSwitchTab(${jsAttr(t.id)})">
                    <i class="fas ${t.icon} mr-1.5"></i>${t.label}
                </button>`).join('')}</div>`;
        }

        function fpsActionsHtml() {
            const tab = FPS_TABS.find((t) => t.id === fpsTab) || FPS_TABS[0];
            return `<div class="fps-list">${tab.actions.map((a, i) => {
                const ref = a.method ? `m:${a.method}` : `a:${a.action}`;
                return `
                <div class="fps-card">
                    <div class="fps-card-text">
                        <div class="fps-card-title">${esc(a.title)}</div>
                        <div class="fps-card-desc">${esc(a.desc)}</div>
                    </div>
                    <button type="button" class="fps-run fps-run-${a.tone} no-drag" ${fpsBusy ? 'disabled' : ''}
                        onclick="fpsRunAction(${jsAttr(fpsTab)}, ${i})">${esc(a.btn || 'Run')}</button>
                </div>`;
            }).join('')}</div>`;
        }

        function fpsSwitchTab(id) {
            if (!FPS_TABS.some((t) => t.id === id)) return;
            fpsTab = id;
            renderFpsOptimizerPanel();
        }

        async function fpsRunAction(tabId, index) {
            if (fpsBusy) return;
            if (!window.electronAPI) return;
            const tab = FPS_TABS.find((t) => t.id === tabId);
            const a = tab && tab.actions[index];
            if (!a) return;

            // Admin-gated actions: ensure the app is elevated first. If it isn't,
            // adminElevate() shows UAC — on accept the app relaunches as admin (this
            // instance quits, so we just stop here), on decline we abort the action.
            if (fpsActionNeedsAdmin(a) && window.electronAPI.adminIsElevated) {
                let elevated = false;
                try { elevated = await window.electronAPI.adminIsElevated(); } catch (e) { elevated = false; }
                if (!elevated) {
                    showToast('Administrator access needed — approve the Windows prompt. main will restart as admin.');
                    let res;
                    try { res = await window.electronAPI.adminElevate(); } catch (e) { res = null; }
                    if (res && res.relaunching) return;         // app is restarting elevated
                    if (!res || res.declined) {
                        showToast(`${a.title} needs administrator access.`, true);
                        return;
                    }
                    // res.alreadyElevated / res.ok → fall through and run.
                }
            }

            fpsBusy = true;
            renderFpsOptimizerPanel();      // repaint with buttons disabled

            // Reset the bar for this run.
            fpsOnProgress({ pct: 0, msg: a.title + '…' });

            try {
                let res;
                if (a.method) res = await window.electronAPI[a.method]();
                else res = await window.electronAPI.fpsAction(a.action);

                if (res && res.success === false) {
                    showToast(res.error || `${a.title} failed`, true);
                } else if (res && res.results && res.results.some((r) => !r.success)) {
                    const failed = res.results.filter((r) => !r.success).length;
                    showToast(`${a.title}: ${failed} step${failed === 1 ? '' : 's'} failed`, true);
                } else {
                    showToast(`${a.title} complete`);
                }
            } catch (e) {
                showToast(`${a.title} failed`, true);
                console.error('FPS action failed', e);
            }

            fpsBusy = false;
            renderFpsOptimizerPanel();       // re-enable buttons
        }
