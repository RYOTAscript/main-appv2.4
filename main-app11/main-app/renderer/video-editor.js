        // ── Video Editor mini widget ──
        // A fast, simple trimmer. The renderer owns the preview (<video>), the
        // in/out timeline, and the export options; the actual trimming runs through
        // bundled FFmpeg in the main process (main/videoEditor.js). The design is
        // deliberately minimal — import, set in/out, keep/drop audio, export — rather
        // than a full editing suite.

        const ve = {
            input: null,        // { path, name, durationMs, width, height, fps, hasAudio, sizeBytes }
            inMs: 0,
            outMs: 0,
            playheadMs: 0,
            outputPath: null,
            exporting: false,
            checked: false,     // whether we've confirmed ffmpeg availability
            available: true
        };
        let veDragging = null;  // 'in' | 'out' | null
        let veProgressBound = false;

        function isVideoEditorEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.videoEditor;
        }

        function veFileUrl(p) {
            const parts = p.replace(/\\/g, '/').split('/');
            return 'file:///' + parts.map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
        }

        function veFormatTime(ms) {
            if (!ms || ms < 0) ms = 0;
            const total = Math.floor(ms / 1000);
            const m = Math.floor(total / 60);
            const s = total % 60;
            const millis = Math.floor(ms % 1000);
            return `${m}:${s.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
        }

        function veFormatBytes(bytes) {
            if (!bytes || bytes <= 0) return '0 MB';
            const mb = bytes / (1024 * 1024);
            if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
            return `${mb.toFixed(1)} MB`;
        }

        function veSuggestOutput(inputPath) {
            const dot = inputPath.lastIndexOf('.');
            const base = dot > 0 ? inputPath.slice(0, dot) : inputPath;
            return `${base}-trim.mp4`;
        }

        async function renderVideoEditorPanel() {
            const panel = document.getElementById('video-editor-panel');
            if (!panel) return;
            if (!isVideoEditorEnabled()) { panel.innerHTML = ''; return; }

            if (!ve.checked && window.electronAPI?.videoCheck) {
                const c = await window.electronAPI.videoCheck();
                ve.available = !!c?.available;
                ve.checked = true;
            }
            if (!window.electronAPI?.videoPickInput || !ve.available) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">The bundled video engine is unavailable.</p>`;
                return;
            }

            if (!ve.input) {
                panel.innerHTML = `<div class="mt-3">
                    <button type="button" onclick="veImport()" class="w-full border border-dashed border-neutral-700 rounded-2xl py-6 flex flex-col items-center gap-2 hover:bg-neutral-900/40 transition-colors no-drag">
                        <i class="fas fa-file-video text-2xl text-neutral-600"></i>
                        <span class="text-xs text-neutral-400">Import a video to trim</span>
                    </button>
                </div>`;
                return;
            }

            const inp = ve.input;
            panel.innerHTML = `<div id="ve-root" class="mt-3 space-y-3">
                <div class="flex items-center justify-between gap-2">
                    <p class="text-xs text-neutral-300 truncate" title="${esc(inp.path)}"><i class="fas fa-film mr-1.5 text-neutral-500"></i>${esc(inp.name)}</p>
                    <button type="button" onclick="veImport()" class="hotkey-bind no-drag shrink-0">Change</button>
                </div>
                <div class="text-[10px] text-neutral-600">${inp.width && inp.height ? `${inp.width}×${inp.height}` : ''}${inp.fps ? ` • ${Math.round(inp.fps)}fps` : ''} • ${veFormatTime(inp.durationMs)} • ${veFormatBytes(inp.sizeBytes)}</div>

                <div class="rounded-xl overflow-hidden bg-black/40 border border-white/10 flex items-center justify-center" style="max-height:220px">
                    <video id="ve-video" class="max-h-[220px] w-full object-contain" preload="metadata"></video>
                </div>

                <!-- Playback controls -->
                <div class="flex items-center gap-3">
                    <button type="button" id="ve-play" onclick="vePlayPause()" class="w-8 h-8 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors no-drag"><i class="fas fa-play text-[11px]"></i></button>
                    <span class="text-[11px] font-mono text-neutral-400"><span id="ve-playhead-label">0:00.000</span> / ${veFormatTime(inp.durationMs)}</span>
                    <div class="flex items-center gap-1 ml-auto">
                        <button type="button" onclick="veStepFrame(-1)" title="Previous frame" class="w-7 h-7 flex items-center justify-center bg-neutral-800/40 border border-neutral-700/50 rounded-lg text-neutral-300 hover:text-white transition-colors no-drag"><i class="fas fa-backward-step text-[10px]"></i></button>
                        <button type="button" onclick="veStepFrame(1)" title="Next frame" class="w-7 h-7 flex items-center justify-center bg-neutral-800/40 border border-neutral-700/50 rounded-lg text-neutral-300 hover:text-white transition-colors no-drag"><i class="fas fa-forward-step text-[10px]"></i></button>
                    </div>
                </div>

                <!-- Timeline -->
                <div id="ve-timeline" class="ve-timeline no-drag">
                    <div id="ve-selection" class="ve-timeline-selection"></div>
                    <div id="ve-playhead" class="ve-playhead"></div>
                    <div id="ve-handle-in" class="ve-handle ve-handle-in" title="Trim start"></div>
                    <div id="ve-handle-out" class="ve-handle ve-handle-out" title="Trim end"></div>
                </div>
                <div class="flex items-center justify-between text-[10px] font-mono text-neutral-500">
                    <button type="button" onclick="veSetIn()" class="hotkey-bind no-drag" title="Set start to playhead">In: <span id="ve-in-label">0:00.000</span></button>
                    <span class="text-neutral-400">Length: <span id="ve-len-label">0:00.000</span></span>
                    <button type="button" onclick="veSetOut()" class="hotkey-bind no-drag" title="Set end to playhead">Out: <span id="ve-out-label">0:00.000</span></button>
                </div>

                <!-- Options -->
                <div class="border-t border-neutral-800 pt-3 space-y-2.5">
                    <label class="flex items-center gap-3 cursor-pointer text-xs ${inp.hasAudio ? '' : 'opacity-40'}">
                        <span class="ios-toggle"><input type="checkbox" id="ve-keep-audio" class="ios-toggle-input" ${inp.hasAudio ? 'checked' : ''} ${inp.hasAudio ? '' : 'disabled'} onchange="veUpdateEstimate()"><span class="ios-toggle-track"></span></span>
                        <span>Keep audio track${inp.hasAudio ? '' : ' (no audio in source)'}</span>
                    </label>
                    <label class="flex items-center gap-3 cursor-pointer text-xs">
                        <span class="ios-toggle"><input type="checkbox" id="ve-precise" class="ios-toggle-input" onchange="veUpdateEstimate()"><span class="ios-toggle-track"></span></span>
                        <span>Precise cut (frame-accurate re-encode)</span>
                    </label>
                    <p class="text-[10px] text-neutral-600 leading-relaxed">Off = lossless & fast (cut snaps to the nearest keyframe, no quality loss). On = exact frame boundary, re-encoded at near-lossless quality (slower).</p>
                </div>

                <!-- Output -->
                <div class="border-t border-neutral-800 pt-3 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-[11px] text-neutral-400 truncate" id="ve-output-label" title="${esc(ve.outputPath || '')}">${esc(ve.outputPath || '')}</p>
                        <button type="button" onclick="vePickOutput()" class="hotkey-bind no-drag shrink-0">Save as…</button>
                    </div>
                    <p class="text-[10px] text-neutral-600">Estimated size: <span id="ve-estimate" class="text-neutral-400">—</span></p>

                    <div id="ve-progress-wrap" class="hidden">
                        <div class="h-1.5 bg-neutral-800 rounded-full overflow-hidden"><div id="ve-progress-bar" class="h-full bg-white/30 rounded-full transition-all" style="width:0%"></div></div>
                        <p id="ve-progress-text" class="text-[10px] text-neutral-500 mt-1">Exporting…</p>
                    </div>
                    <div id="ve-done" class="hidden flex items-center justify-between gap-2 border border-green-700/40 bg-green-700/10 rounded-xl p-2.5">
                        <span class="text-[11px] text-green-300 truncate"><i class="fas fa-check mr-1"></i><span id="ve-done-text"></span></span>
                        <button type="button" onclick="veReveal()" class="hotkey-bind no-drag shrink-0">Open folder</button>
                    </div>

                    <div class="flex items-center gap-2">
                        <button type="button" id="ve-export-btn" onclick="veExport()" class="flex-1 bg-white text-black py-2 rounded-xl text-xs font-medium hover:bg-neutral-200 transition-colors no-drag">Export trimmed video</button>
                        <button type="button" id="ve-cancel-btn" onclick="veCancel()" class="hidden px-3 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-xl text-xs text-red-400 transition-colors no-drag">Cancel</button>
                    </div>
                </div>
            </div>`;

            bindVideoEditor();
            veUpdateUI();
            veUpdateEstimate();
        }

        function bindVideoEditor() {
            const video = document.getElementById('ve-video');
            if (video && ve.input) {
                video.src = veFileUrl(ve.input.path);
                video.onerror = () => {
                    const wrap = video.parentElement;
                    if (wrap) wrap.innerHTML = `<p class="text-[10px] text-neutral-600 p-4 text-center">Preview unavailable for this format — trimming still works.</p>`;
                };
                video.addEventListener('timeupdate', () => {
                    ve.playheadMs = video.currentTime * 1000;
                    // Clamp preview playback to the selected [in, out] window.
                    if (!video.paused && ve.playheadMs >= ve.outMs) {
                        video.pause();
                        video.currentTime = ve.outMs / 1000;
                        ve.playheadMs = ve.outMs;
                        veReflectPlayState();
                    }
                    veUpdatePlayhead();
                });
                video.addEventListener('play', veReflectPlayState);
                video.addEventListener('pause', veReflectPlayState);
                video.addEventListener('loadedmetadata', () => { video.currentTime = ve.inMs / 1000; });
            }

            const timeline = document.getElementById('ve-timeline');
            if (timeline) {
                const handleIn = document.getElementById('ve-handle-in');
                const handleOut = document.getElementById('ve-handle-out');
                handleIn?.addEventListener('mousedown', (e) => { e.preventDefault(); veDragging = 'in'; });
                handleOut?.addEventListener('mousedown', (e) => { e.preventDefault(); veDragging = 'out'; });
                timeline.addEventListener('mousedown', (e) => {
                    if (e.target === handleIn || e.target === handleOut) return;
                    veSeekFromEvent(e);
                });
                document.addEventListener('mousemove', veOnDragMove);
                document.addEventListener('mouseup', veOnDragEnd);
            }
        }

        function veTimelinePct(e) {
            const timeline = document.getElementById('ve-timeline');
            if (!timeline) return 0;
            const rect = timeline.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        }

        function veOnDragMove(e) {
            if (!veDragging || !ve.input) return;
            const ms = veTimelinePct(e) * ve.input.durationMs;
            const video = document.getElementById('ve-video');
            if (veDragging === 'in') {
                ve.inMs = Math.min(ms, ve.outMs - 50);
                ve.inMs = Math.max(0, ve.inMs);
                if (video) video.currentTime = ve.inMs / 1000;
            } else {
                ve.outMs = Math.max(ms, ve.inMs + 50);
                ve.outMs = Math.min(ve.input.durationMs, ve.outMs);
                if (video) video.currentTime = ve.outMs / 1000;
            }
            veUpdateUI();
            veUpdateEstimate();
        }

        function veOnDragEnd() {
            if (veDragging) veDragging = null;
        }

        function veSeekFromEvent(e) {
            if (!ve.input) return;
            const ms = veTimelinePct(e) * ve.input.durationMs;
            const video = document.getElementById('ve-video');
            if (video) video.currentTime = ms / 1000;
            ve.playheadMs = ms;
            veUpdatePlayhead();
        }

        // Positions handles/selection/playhead and refreshes the time labels.
        function veUpdateUI() {
            if (!ve.input) return;
            const dur = ve.input.durationMs || 1;
            const inPct = (ve.inMs / dur) * 100;
            const outPct = (ve.outMs / dur) * 100;
            const hIn = document.getElementById('ve-handle-in');
            const hOut = document.getElementById('ve-handle-out');
            const sel = document.getElementById('ve-selection');
            if (hIn) hIn.style.left = `${inPct}%`;
            if (hOut) hOut.style.left = `${outPct}%`;
            if (sel) { sel.style.left = `${inPct}%`; sel.style.width = `${Math.max(0, outPct - inPct)}%`; }
            const inLabel = document.getElementById('ve-in-label');
            const outLabel = document.getElementById('ve-out-label');
            const lenLabel = document.getElementById('ve-len-label');
            if (inLabel) inLabel.textContent = veFormatTime(ve.inMs);
            if (outLabel) outLabel.textContent = veFormatTime(ve.outMs);
            if (lenLabel) lenLabel.textContent = veFormatTime(ve.outMs - ve.inMs);
            veUpdatePlayhead();
        }

        function veUpdatePlayhead() {
            if (!ve.input) return;
            const dur = ve.input.durationMs || 1;
            const ph = document.getElementById('ve-playhead');
            if (ph) ph.style.left = `${Math.max(0, Math.min(100, (ve.playheadMs / dur) * 100))}%`;
            const lbl = document.getElementById('ve-playhead-label');
            if (lbl) lbl.textContent = veFormatTime(ve.playheadMs);
        }

        function veReflectPlayState() {
            const video = document.getElementById('ve-video');
            const btn = document.getElementById('ve-play');
            if (!video || !btn) return;
            const icon = btn.querySelector('i');
            if (icon) icon.className = video.paused ? 'fas fa-play text-[11px]' : 'fas fa-pause text-[11px]';
        }

        function vePlayPause() {
            const video = document.getElementById('ve-video');
            if (!video) return;
            if (video.paused) {
                // Start from the in-point if we're outside the selection.
                if (video.currentTime * 1000 < ve.inMs || video.currentTime * 1000 >= ve.outMs) {
                    video.currentTime = ve.inMs / 1000;
                }
                video.play();
            } else {
                video.pause();
            }
        }

        function veStepFrame(dir) {
            const video = document.getElementById('ve-video');
            if (!video || !ve.input) return;
            const frame = ve.input.fps ? 1 / ve.input.fps : 0.033;
            video.pause();
            video.currentTime = Math.max(0, Math.min(ve.input.durationMs / 1000, video.currentTime + dir * frame));
        }

        function veSetIn() {
            if (!ve.input) return;
            ve.inMs = Math.min(ve.playheadMs, ve.outMs - 50);
            ve.inMs = Math.max(0, ve.inMs);
            veUpdateUI();
            veUpdateEstimate();
        }

        function veSetOut() {
            if (!ve.input) return;
            ve.outMs = Math.max(ve.playheadMs, ve.inMs + 50);
            ve.outMs = Math.min(ve.input.durationMs, ve.outMs);
            veUpdateUI();
            veUpdateEstimate();
        }

        function veUpdateEstimate() {
            const el = document.getElementById('ve-estimate');
            if (!el || !ve.input) return;
            const dur = ve.input.durationMs || 1;
            const frac = Math.max(0, Math.min(1, (ve.outMs - ve.inMs) / dur));
            // Proportional estimate off the source size. Dropping audio trims a little
            // more; precise re-encode is only approximate, so label it as such.
            const keepAudio = document.getElementById('ve-keep-audio')?.checked !== false && ve.input.hasAudio;
            const precise = !!document.getElementById('ve-precise')?.checked;
            let est = ve.input.sizeBytes * frac;
            if (!keepAudio) est *= 0.92;
            el.textContent = `~${veFormatBytes(est)}${precise ? ' (approx.)' : ''}`;
        }

        async function veImport() {
            if (!window.electronAPI?.videoPickInput) return;
            const res = await window.electronAPI.videoPickInput();
            if (res?.canceled) return;
            if (!res?.ok) { showToast(res?.error || 'Could not import video', true); return; }
            ve.input = res;
            ve.inMs = 0;
            ve.outMs = res.durationMs;
            ve.playheadMs = 0;
            ve.outputPath = veSuggestOutput(res.path);
            veResetExportUI();
            renderVideoEditorPanel();
            showToast('Video imported');
        }

        async function vePickOutput() {
            if (!window.electronAPI?.videoPickOutput) return;
            const res = await window.electronAPI.videoPickOutput(ve.outputPath || undefined);
            if (res?.ok && res.path) {
                ve.outputPath = res.path;
                const label = document.getElementById('ve-output-label');
                if (label) { label.textContent = res.path; label.title = res.path; }
            }
        }

        function veResetExportUI() {
            document.getElementById('ve-progress-wrap')?.classList.add('hidden');
            document.getElementById('ve-done')?.classList.add('hidden');
        }

        async function veExport() {
            if (ve.exporting || !ve.input || !window.electronAPI?.videoExport) return;
            if (!ve.outputPath) { showToast('Choose a save location first', true); return; }
            if (ve.outMs - ve.inMs < 100) { showToast('Trim range is too short', true); return; }

            if (!veProgressBound && window.electronAPI?.onVideoExportProgress) {
                window.electronAPI.onVideoExportProgress((data) => {
                    const bar = document.getElementById('ve-progress-bar');
                    const text = document.getElementById('ve-progress-text');
                    if (bar && typeof data.percent === 'number') bar.style.width = `${data.percent.toFixed(1)}%`;
                    if (text && typeof data.percent === 'number') text.textContent = `Exporting… ${Math.round(data.percent)}%`;
                });
                veProgressBound = true;
            }

            const keepAudio = document.getElementById('ve-keep-audio')?.checked !== false && ve.input.hasAudio;
            const precise = !!document.getElementById('ve-precise')?.checked;

            ve.exporting = true;
            veResetExportUI();
            document.getElementById('ve-progress-wrap')?.classList.remove('hidden');
            const bar = document.getElementById('ve-progress-bar');
            if (bar) bar.style.width = '0%';
            const exportBtn = document.getElementById('ve-export-btn');
            const cancelBtn = document.getElementById('ve-cancel-btn');
            if (exportBtn) { exportBtn.setAttribute('disabled', ''); exportBtn.classList.add('opacity-50'); }
            if (cancelBtn) cancelBtn.classList.remove('hidden');

            try {
                const res = await window.electronAPI.videoExport({
                    inputPath: ve.input.path,
                    outputPath: ve.outputPath,
                    startMs: Math.round(ve.inMs),
                    endMs: Math.round(ve.outMs),
                    keepAudio,
                    precise
                });
                if (res?.ok) {
                    document.getElementById('ve-progress-wrap')?.classList.add('hidden');
                    const done = document.getElementById('ve-done');
                    const doneText = document.getElementById('ve-done-text');
                    if (doneText) doneText.textContent = `Saved — ${veFormatBytes(res.sizeBytes)}`;
                    if (done) { done.classList.remove('hidden'); done.title = res.outputPath; }
                    showToast('Export complete');
                } else if (res?.cancelled) {
                    document.getElementById('ve-progress-wrap')?.classList.add('hidden');
                    showToast('Export cancelled');
                } else {
                    document.getElementById('ve-progress-wrap')?.classList.add('hidden');
                    showToast(res?.error || 'Export failed', true);
                }
            } catch (e) {
                showToast('Export failed', true);
            } finally {
                ve.exporting = false;
                if (exportBtn) { exportBtn.removeAttribute('disabled'); exportBtn.classList.remove('opacity-50'); }
                if (cancelBtn) cancelBtn.classList.add('hidden');
            }
        }

        async function veCancel() {
            if (window.electronAPI?.videoCancel) await window.electronAPI.videoCancel();
        }

        function veReveal() {
            if (ve.outputPath && window.electronAPI?.videoReveal) window.electronAPI.videoReveal(ve.outputPath);
        }
