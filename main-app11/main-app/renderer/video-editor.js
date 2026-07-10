        // ── Video Editor mini widget ──
        // A fast, simple trimmer. The renderer owns the preview (<video>), the
        // in/out timeline, and the export options; the actual trimming runs through
        // bundled FFmpeg in the main process (main/videoEditor.js). The design is
        // deliberately minimal — import, set in/out, keep/drop audio, export — rather
        // than a full editing suite.

        const ve = {
            input: null,        // { path, name, durationMs, width, height, fps, hasAudio, audioTracks, sizeBytes }
            inMs: 0,
            outMs: 0,
            playheadMs: 0,
            outputPath: null,
            exporting: false,
            checked: false,     // whether we've confirmed ffmpeg availability
            available: true,
            audioTracks: [],    // [{ aIndex, language, codec, channels, title, enabled, volume }]
            previewQuality: 'original', // original | 1080 | 720 | 360
            proxyPath: null,    // path of the low-res preview currently in use, if any
            proxyKey: null,     // "<inputPath>|<height>" the current proxy was built for
            proxyBusy: false,   // a proxy build is in flight
            _pendingSeekSec: null, // preserve playhead across a preview source swap
            _resumeAfterLoad: false,
            filmstrip: null,    // video-lane thumbnail-strip image path
            waveforms: {},      // aIndex -> waveform image path
            assetsBusy: false,  // timeline assets (filmstrip/waveforms) are rendering
            assetsKey: null     // input path the current assets belong to
        };
        let veDragging = null;  // 'in' | 'out' | null
        let veProgressBound = false;
        let veProxyProgressBound = false;
        let veKeysBound = false;
        ve.previewQuality = localStorage.getItem('vePreviewQuality') || 'original';

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
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button type="button" id="ve-settings-btn" onclick="veToggleSettings()" title="Player settings" class="w-7 h-7 flex items-center justify-center bg-neutral-800/40 border border-neutral-700/50 rounded-lg text-neutral-300 hover:text-white transition-colors no-drag"><i class="fas fa-gear text-[11px]"></i></button>
                        <button type="button" onclick="veImport()" class="hotkey-bind no-drag">Change</button>
                    </div>
                </div>
                <div class="text-[10px] text-neutral-600">${inp.width && inp.height ? `${inp.width}×${inp.height}` : ''}${inp.fps ? ` • ${Math.round(inp.fps)}fps` : ''} • ${veFormatTime(inp.durationMs)} • ${veFormatBytes(inp.sizeBytes)}</div>

                <!-- Player settings (preview quality + audio track), toggled by the gear -->
                <div id="ve-settings" class="hidden border border-white/10 rounded-xl p-3 space-y-3 bg-neutral-900/40">
                    <div>
                        <p class="text-[11px] text-neutral-300 mb-1.5">Preview quality</p>
                        <div class="grid grid-cols-4 gap-1.5" id="ve-quality-row"></div>
                        <p class="text-[10px] text-neutral-600 mt-1.5" id="ve-quality-note"></p>
                        <div id="ve-proxy-progress" class="hidden mt-2">
                            <div class="flex items-center justify-between mb-1">
                                <span class="text-[10px] text-neutral-500" id="ve-proxy-text">Preparing preview…</span>
                                <button type="button" onclick="veCancelProxy()" class="text-[10px] text-red-400 hover:text-red-300 no-drag">Cancel</button>
                            </div>
                            <div class="h-1.5 bg-neutral-800 rounded-full overflow-hidden"><div id="ve-proxy-bar" class="h-full bg-white/30 rounded-full transition-all" style="width:0%"></div></div>
                        </div>
                    </div>
                    <div id="ve-audio-tracks-wrap"></div>
                </div>

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
                <p class="text-[10px] text-neutral-600 -mt-1"><kbd class="text-neutral-500">Space</kbd> play/pause · <kbd class="text-neutral-500">←</kbd> <kbd class="text-neutral-500">→</kbd> step one frame</p>

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

                <!-- Vegas-style track lanes: video on top, one row per audio track -->
                <div id="ve-tracks" class="ve-tracks no-drag">${veTracksLanesHtml()}
                    <div id="ve-tracks-dim-left" class="ve-tracks-dim"></div>
                    <div id="ve-tracks-dim-right" class="ve-tracks-dim"></div>
                    <div id="ve-tracks-sel" class="ve-tracks-sel"></div>
                    <div id="ve-tracks-playhead" class="ve-tracks-playhead"></div>
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
            initVeKeys();
            veUpdateUI();
            veUpdateEstimate();
            veUpdateSettingsUI();
            // Re-apply the chosen preview quality for this clip (builds/reuses a proxy
            // when a lower quality is selected; a no-op for "Original").
            veApplyPreviewQuality();
            // Fetch/paint the track waveforms + video filmstrip.
            veLoadTimelineAssets();
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
                video.addEventListener('loadedmetadata', () => {
                    // A preview-quality swap sets a pending position so the playhead
                    // stays put; otherwise land on the trim in-point.
                    const seekTo = (ve._pendingSeekSec != null) ? ve._pendingSeekSec : ve.inMs / 1000;
                    try { video.currentTime = seekTo; } catch (e) { /* ignore */ }
                    ve._pendingSeekSec = null;
                    if (ve._resumeAfterLoad) { ve._resumeAfterLoad = false; video.play().catch(() => {}); }
                });
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

            // Clicking anywhere on the track lanes seeks — they share the timeline's
            // exact horizontal extent, so the same percentage math applies.
            const tracks = document.getElementById('ve-tracks');
            if (tracks) {
                tracks.addEventListener('mousedown', (e) => {
                    // Don't seek when the user is grabbing a track's checkbox or
                    // volume slider — those own their own interaction.
                    if (e.target.closest('.ve-lane-check, .ve-lane-vol')) return;
                    veSeekFromEvent(e);
                });
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
            // Mirror the trim selection onto the track lanes (dim outside [in,out]).
            const dimL = document.getElementById('ve-tracks-dim-left');
            const dimR = document.getElementById('ve-tracks-dim-right');
            const selT = document.getElementById('ve-tracks-sel');
            if (dimL) { dimL.style.left = '0%'; dimL.style.width = `${inPct}%`; }
            if (dimR) { dimR.style.left = `${outPct}%`; dimR.style.width = `${Math.max(0, 100 - outPct)}%`; }
            if (selT) { selT.style.left = `${inPct}%`; selT.style.width = `${Math.max(0, outPct - inPct)}%`; }
            veUpdatePlayhead();
        }

        function veUpdatePlayhead() {
            if (!ve.input) return;
            const dur = ve.input.durationMs || 1;
            const pct = Math.max(0, Math.min(100, (ve.playheadMs / dur) * 100));
            const ph = document.getElementById('ve-playhead');
            if (ph) ph.style.left = `${pct}%`;
            const tph = document.getElementById('ve-tracks-playhead');
            if (tph) tph.style.left = `${pct}%`;
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
            // Every track starts enabled at full volume — by default all of them
            // are exported. The per-lane checkbox/slider mutate these in place.
            ve.audioTracks = (Array.isArray(res.audioTracks) ? res.audioTracks : [])
                .map((t) => ({ ...t, enabled: true, volume: 1 }));
            // The old file's proxy no longer applies to this one.
            ve.proxyPath = null;
            ve.proxyKey = null;
            ve.proxyBusy = false;
            // Nor do its timeline assets.
            ve.filmstrip = null;
            ve.waveforms = {};
            ve.assetsKey = null;
            ve.assetsBusy = false;
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
            // Keep every ticked track, each carrying its own volume multiplier.
            const audioSelections = keepAudio
                ? (ve.audioTracks || [])
                    .filter((t) => t.enabled !== false)
                    .map((t) => ({ aIndex: t.aIndex, volume: t.volume == null ? 1 : t.volume }))
                : [];

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
                    precise,
                    audioSelections
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

        // ── Player settings (gear): preview quality + audio track ──

        function veToggleSettings() {
            const box = document.getElementById('ve-settings');
            if (!box) return;
            box.classList.toggle('hidden');
            if (!box.classList.contains('hidden')) veUpdateSettingsUI();
        }

        // A quality only applies if it's actually smaller than the source — no point
        // (and no gain) building a proxy at or above the original height.
        function veQualityApplies(q) {
            if (q === 'original') return false;
            const h = parseInt(q, 10);
            if (!ve.input || !ve.input.height) return true; // unknown height → allow
            return h < ve.input.height;
        }

        function veSetPreviewQuality(q) {
            if (ve.previewQuality === q) return;
            ve.previewQuality = q;
            localStorage.setItem('vePreviewQuality', q);
            veUpdateSettingsUI();
            veApplyPreviewQuality();
        }

        // Swaps the <video> source (proxy ↔ original) while keeping the current
        // position and play state. No-op when the requested source is already loaded.
        function veSwapSource(url, keepPosition) {
            const video = document.getElementById('ve-video');
            if (!video) return;
            if (video.currentSrc === url || video.src === url) return;
            ve._pendingSeekSec = keepPosition ? video.currentTime : (ve.inMs / 1000);
            ve._resumeAfterLoad = keepPosition ? !video.paused : false;
            video.src = url;
            video.load();
        }

        // Ensures the preview is showing whatever quality is selected: the original
        // file for "Original" (or when a lower quality wouldn't help), otherwise a
        // cached/freshly-built low-res proxy.
        async function veApplyPreviewQuality() {
            const video = document.getElementById('ve-video');
            if (!video || !ve.input) return;
            const q = ve.previewQuality;

            if (!veQualityApplies(q)) {
                if (ve.proxyBusy && window.electronAPI?.videoCancelProxy) {
                    await window.electronAPI.videoCancelProxy();
                }
                ve.proxyBusy = false;
                ve.proxyPath = null;
                ve.proxyKey = null;
                veSwapSource(veFileUrl(ve.input.path), true);
                veUpdateSettingsUI();
                return;
            }

            const height = parseInt(q, 10);
            const key = `${ve.input.path}|${height}`;
            // Already on the right proxy — nothing to do.
            if (ve.proxyPath && ve.proxyKey === key) {
                veSwapSource(veFileUrl(ve.proxyPath), true);
                return;
            }
            if (!window.electronAPI?.videoMakeProxy) return;

            bindProxyProgress();
            ve.proxyBusy = true;
            veUpdateSettingsUI();
            const res = await window.electronAPI.videoMakeProxy({
                inputPath: ve.input.path,
                height,
                durationMs: ve.input.durationMs
            });
            ve.proxyBusy = false;

            // The user may have changed the selection while we were building.
            if (ve.previewQuality !== q) { veUpdateSettingsUI(); return; }

            if (res?.ok && res.path) {
                ve.proxyPath = res.path;
                ve.proxyKey = key;
                veSwapSource(veFileUrl(res.path), true);
            } else if (res?.cancelled) {
                // Selection was reverted elsewhere; leave the preview as-is.
            } else {
                showToast(res?.error || 'Could not build the preview', true);
                ve.previewQuality = 'original';
                localStorage.setItem('vePreviewQuality', 'original');
                veSwapSource(veFileUrl(ve.input.path), true);
            }
            veUpdateSettingsUI();
        }

        async function veCancelProxy() {
            if (window.electronAPI?.videoCancelProxy) await window.electronAPI.videoCancelProxy();
            ve.proxyBusy = false;
            ve.previewQuality = 'original';
            localStorage.setItem('vePreviewQuality', 'original');
            veUpdateSettingsUI();
            veApplyPreviewQuality();
        }

        function bindProxyProgress() {
            if (veProxyProgressBound || !window.electronAPI?.onVideoProxyProgress) return;
            window.electronAPI.onVideoProxyProgress((data) => {
                const bar = document.getElementById('ve-proxy-bar');
                const text = document.getElementById('ve-proxy-text');
                if (bar && typeof data.percent === 'number') bar.style.width = `${data.percent.toFixed(1)}%`;
                if (text && typeof data.percent === 'number') text.textContent = `Preparing preview… ${Math.round(data.percent)}%`;
            });
            veProxyProgressBound = true;
        }

        // Repaints the quality buttons, the note, the proxy progress row and the
        // audio-track picker to reflect current state.
        function veUpdateSettingsUI() {
            if (!ve.input) return;
            const row = document.getElementById('ve-quality-row');
            if (row) {
                const srcH = ve.input.height || 0;
                const opts = [
                    { v: 'original', l: 'Original' },
                    { v: '1080', l: '1080p' },
                    { v: '720', l: '720p' },
                    { v: '360', l: '360p' }
                ];
                row.innerHTML = opts.map((o) => {
                    // Disable qualities that are at/above the source resolution.
                    const disabled = o.v !== 'original' && srcH > 0 && parseInt(o.v, 10) >= srcH;
                    const active = ve.previewQuality === o.v;
                    return `<button type="button" ${disabled ? 'disabled' : ''} onclick="veSetPreviewQuality('${o.v}')"
                        class="px-1.5 py-1.5 rounded-lg text-[11px] border transition-colors no-drag ${active
                            ? 'bg-white/15 border-white/25 text-white'
                            : 'bg-neutral-800/30 border-neutral-700/50 text-neutral-400 hover:text-neutral-200'} ${disabled ? 'opacity-30 cursor-not-allowed' : ''}">${o.l}</button>`;
                }).join('');
            }
            const note = document.getElementById('ve-quality-note');
            if (note) {
                note.textContent = ve.input.height
                    ? `Source is ${ve.input.height}p. A lower preview plays smoother on heavy clips — exports always use the original.`
                    : 'A lower preview plays smoother on heavy clips — exports always use the original.';
            }
            const prog = document.getElementById('ve-proxy-progress');
            if (prog) prog.classList.toggle('hidden', !ve.proxyBusy);
            const btn = document.getElementById('ve-settings-btn');
            // Subtle hint on the gear when a non-original preview is active.
            if (btn) btn.classList.toggle('text-white', veQualityApplies(ve.previewQuality));
            renderVeAudioTracks();
        }

        function renderVeAudioTracks() {
            const wrap = document.getElementById('ve-audio-tracks-wrap');
            if (!wrap || !ve.input) return;
            const tracks = ve.audioTracks || [];
            if (tracks.length === 0) {
                wrap.innerHTML = `<p class="text-[10px] text-neutral-600"><i class="fas fa-volume-xmark mr-1"></i>No audio track in this file</p>`;
                return;
            }
            const enabledCount = tracks.filter((t) => t.enabled !== false).length;
            const noun = tracks.length === 1 ? 'audio track' : 'audio tracks';
            wrap.innerHTML = `<p class="text-[11px] text-neutral-300 mb-1"><i class="fas fa-layer-group mr-1 text-neutral-500"></i>${tracks.length} ${noun} detected${tracks.length > 1 ? ` — ${enabledCount} exporting` : ''}</p>
                <p class="text-[10px] text-neutral-600">Tick a track to include it in the export and drag its slider to set volume, right on the timeline lanes below. All tracks export by default.</p>`;
        }

        // True when the Video Editor's preview is genuinely visible on screen:
        // getClientRects() is empty if any ancestor is display:none (Settings
        // closed / a different widget's panel), and the viewport test rejects the
        // case where the user has scrolled it out of view. Used both to scope the
        // playback hotkeys and to stop stray keystrokes from hijacking the
        // Settings search box (renderer/spotify-widget.js) while editing.
        function veIsPreviewOnScreen() {
            if (!isVideoEditorEnabled()) return false;
            const video = document.getElementById('ve-video');
            if (!video || !ve.input) return false;
            if (video.getClientRects().length === 0) return false;
            const r = video.getBoundingClientRect();
            const vh = window.innerHeight || document.documentElement.clientHeight;
            if (r.width === 0 || r.bottom <= 0 || r.top >= vh) return false;
            return true;
        }

        // Toggles whether a track is included in the export and greys its lane out.
        function veToggleTrack(aIndex, enabled) {
            const t = (ve.audioTracks || []).find((x) => x.aIndex === aIndex);
            if (t) t.enabled = !!enabled;
            const lane = document.querySelector(`.ve-lane-audio[data-aindex="${aIndex}"]`);
            if (lane) lane.classList.toggle('ve-lane-disabled', !enabled);
            renderVeAudioTracks();   // refresh the "N exporting" summary
            veUpdateEstimate();
        }

        // Sets a track's volume multiplier (slider is a percentage, 0–150%).
        function veSetTrackVolume(aIndex, val) {
            const pct = Math.max(0, Math.min(150, parseInt(val, 10) || 0));
            const t = (ve.audioTracks || []).find((x) => x.aIndex === aIndex);
            if (t) t.volume = pct / 100;
            const out = document.getElementById(`ve-vol-val-${aIndex}`);
            if (out) out.textContent = `${pct}%`;
        }

        // Space = play/pause, ←/→ = step one frame. Active only while the Video
        // Editor's preview is actually on screen (Settings open) and the user isn't
        // typing in a field. Bound once for the app's lifetime.
        function initVeKeys() {
            if (veKeysBound) return;
            veKeysBound = true;
            document.addEventListener('keydown', (e) => {
                if (!veIsPreviewOnScreen()) return;
                const t = e.target;
                const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
                if (e.key === ' ' || e.code === 'Space') {
                    if (tag === 'BUTTON') return; // let Space activate a focused button
                    e.preventDefault();
                    vePlayPause();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    veStepFrame(-1);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    veStepFrame(1);
                }
            });
        }

        // ── Vegas-style track lanes (video filmstrip + one waveform per audio track) ──

        // A short lane label, e.g. "A1 · ENG" or "A2 · Commentary".
        function veLaneLabel(t, i) {
            const parts = [`A${i + 1}`];
            if (t.language) parts.push(t.language.toUpperCase());
            else if (t.title) parts.push(t.title);
            else if (t.channels) parts.push(t.channels);
            return parts.join(' · ');
        }

        // Builds the lane elements (used both in the initial render and rebuilt on
        // import). Background images are filled in later by veApplyTrackAssets once
        // FFmpeg has rendered them (or immediately, if already cached in state).
        function veTracksLanesHtml() {
            if (!ve.input) return '';
            const tracks = ve.audioTracks || [];
            let html = '';
            const filmStyle = ve.filmstrip ? ` style="background-image:url('${veFileUrl(ve.filmstrip)}')"` : '';
            const filmEmpty = !ve.filmstrip ? `<span class="ve-lane-video-empty"><i class="fas fa-film"></i></span>` : '';
            html += `<div class="ve-lane ve-lane-video" id="ve-lane-video"${filmStyle}><span class="ve-lane-tag">Video</span>${filmEmpty}</div>`;
            tracks.forEach((t, i) => {
                const wf = ve.waveforms[t.aIndex];
                const waveStyle = wf ? ` style="background-image:url('${veFileUrl(wf)}')"` : '';
                const enabled = t.enabled !== false;
                const volPct = Math.round((t.volume == null ? 1 : t.volume) * 100);
                html += `<div class="ve-lane ve-lane-audio${enabled ? '' : ' ve-lane-disabled'}" data-aindex="${t.aIndex}">
                    <label class="ve-lane-check no-drag" title="Include this track in the export"><input type="checkbox" ${enabled ? 'checked' : ''} onchange="veToggleTrack(${t.aIndex}, this.checked)"></label>
                    <span class="ve-lane-tag">${esc(veLaneLabel(t, i))}</span>
                    <div class="ve-wave" id="ve-wave-lane-${t.aIndex}"${waveStyle}></div>
                    <div class="ve-lane-vol no-drag" title="Track volume">
                        <i class="fas fa-volume-high"></i>
                        <input type="range" min="0" max="150" value="${volPct}" class="ve-vol-slider" oninput="veSetTrackVolume(${t.aIndex}, this.value)">
                        <span class="ve-vol-val" id="ve-vol-val-${t.aIndex}">${volPct}%</span>
                    </div>
                </div>`;
            });
            return html;
        }

        // Paints the filmstrip/waveform backgrounds onto the existing lanes and
        // toggles the loading shimmer — without rebuilding the DOM, so the selection
        // and playhead overlays stay put.
        function veApplyTrackAssets() {
            const vlane = document.getElementById('ve-lane-video');
            if (vlane) {
                vlane.classList.toggle('ve-lane-loading', !ve.filmstrip && ve.assetsBusy);
                if (ve.filmstrip) {
                    vlane.style.backgroundImage = `url('${veFileUrl(ve.filmstrip)}')`;
                    vlane.querySelector('.ve-lane-video-empty')?.remove();
                }
            }
            (ve.audioTracks || []).forEach((t) => {
                const lane = document.querySelector(`.ve-lane-audio[data-aindex="${t.aIndex}"]`);
                const wave = document.getElementById(`ve-wave-lane-${t.aIndex}`);
                const wf = ve.waveforms[t.aIndex];
                if (lane) lane.classList.toggle('ve-lane-loading', !wf && ve.assetsBusy);
                if (wave && wf) wave.style.backgroundImage = `url('${veFileUrl(wf)}')`;
            });
        }

        // Requests (or reuses) the timeline assets for the current clip and paints them.
        async function veLoadTimelineAssets() {
            if (!ve.input || !window.electronAPI?.videoTimelineAssets) return;
            // Already have assets for this exact file — just (re)paint.
            if (ve.assetsKey === ve.input.path && (ve.filmstrip || Object.keys(ve.waveforms).length)) {
                veApplyTrackAssets();
                return;
            }
            ve.assetsBusy = true;
            veApplyTrackAssets(); // show shimmer
            const audioIndices = (ve.audioTracks || []).map((t) => t.aIndex);
            const inputAtRequest = ve.input.path;
            const res = await window.electronAPI.videoTimelineAssets({
                inputPath: inputAtRequest,
                audioIndices,
                durationMs: ve.input.durationMs
            });
            // Ignore if the user swapped to a different clip meanwhile.
            if (!ve.input || ve.input.path !== inputAtRequest) return;
            ve.assetsBusy = false;
            if (res?.ok) {
                ve.assetsKey = ve.input.path;
                ve.filmstrip = res.filmstrip || null;
                ve.waveforms = {};
                (res.waveforms || []).forEach((w) => { ve.waveforms[w.aIndex] = w.path; });
            }
            veApplyTrackAssets();
        }
