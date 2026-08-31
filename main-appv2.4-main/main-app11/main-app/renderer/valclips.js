        // ── ValClips Quality mini widget (renderer) ──
        // Front-end for main/valclips.js. Everything heavy (probe, analysis,
        // encode, VMAF, previews) runs in the main process; this owns the panel
        // UI, the drop zone, the job list, and the Tune / Compare modals. Styled
        // with the app's own surfaces + accent theme (see .vq-* rules in main.css)
        // so it matches the rest of the launcher rather than the standalone app.

        const vcq = {
            ffmpeg: null,       // last FFmpeg engine state
            settings: null,     // last AppSettings
            jobs: [],           // last job list
            expanded: new Set(),// job ids whose detail is open
            checklist: new Set()// job ids whose upload checklist is open
        };
        let vcqBound = false;
        let vcqTune = null;     // { jobId, overrides, seq, timer }
        let vcqCompare = null;  // { jobId, spot, mode, wipe, zoom, playing }

        const TIKTOK_SIZE_LIMIT = 287 * 1024 * 1024;

        function isValclipsEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.valclips;
        }

        function vcFmtBytes(bytes) {
            if (!bytes || bytes <= 0) return '0 MB';
            const mb = bytes / (1024 * 1024);
            if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
            return `${mb.toFixed(1)} MB`;
        }
        function vcFmtDuration(sec) {
            sec = Math.max(0, Math.round(sec || 0));
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
        }
        // Elapsed process time as H:MM:SS / M:SS.
        function vcFmtElapsed(ms) {
            const total = Math.max(0, Math.floor((ms || 0) / 1000));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            return h > 0
                ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
                : `${m}:${String(s).padStart(2, '0')}`;
        }


        // Bind the two live event streams exactly once for the app's lifetime.
        function vcqBindEvents() {
            if (vcqBound) return;
            vcqBound = true;
            if (window.electronAPI?.onValclipsJobs) {
                window.electronAPI.onValclipsJobs((jobs) => {
                    vcq.jobs = Array.isArray(jobs) ? jobs : [];
                    vcRenderJobs();
                    vcSyncModals();
                });
            }
            if (window.electronAPI?.onValclipsFfmpegState) {
                window.electronAPI.onValclipsFfmpegState((s) => {
                    vcq.ffmpeg = s;
                    vcRenderEngine();
                    vcRenderControls();
                });
            }
        }

        async function renderValclipsPanel() {
            const panel = document.getElementById('valclips-panel');
            if (!panel) return;
            if (!isValclipsEnabled()) { panel.innerHTML = ''; return; }
            if (!window.electronAPI?.valclipsFfmpegState) {
                panel.innerHTML = `<p class="text-xs text-neutral-600 mt-3">The ValClips engine is unavailable in this build.</p>`;
                return;
            }
            vcqBindEvents();

            // Pull fresh state (cheap IPC). Cached values paint instantly on re-open.
            try {
                const [state, settings, jobs] = await Promise.all([
                    window.electronAPI.valclipsFfmpegState(),
                    window.electronAPI.valclipsSettingsGet(),
                    window.electronAPI.valclipsJobsList()
                ]);
                vcq.ffmpeg = state;
                vcq.settings = settings;
                vcq.jobs = Array.isArray(jobs) ? jobs : [];
            } catch (e) { /* keep whatever we had */ }

            panel.innerHTML = `<div id="vq-root" class="mt-3 space-y-3">
                <div id="vq-engine"></div>
                <div id="vq-controls"></div>
                <div id="vq-jobs"></div>
                <div id="vq-settings-wrap"></div>
            </div>`;

            vcRenderEngine();
            vcRenderControls();
            vcRenderJobs();
            vcRenderSettings();
        }

        function vcEngineReady() { return vcq.ffmpeg && vcq.ffmpeg.status === 'ready'; }

        // ── FFmpeg engine status card ──
        function vcRenderEngine() {
            const el = document.getElementById('vq-engine');
            if (!el) return;
            const s = vcq.ffmpeg;
            if (!s || s.status === 'checking') {
                el.innerHTML = `<div class="vq-engine vq-engine-info"><i class="fas fa-circle-notch fa-spin"></i><span>Checking for a capable FFmpeg…</span></div>`;
                return;
            }
            if (s.status === 'ready') {
                el.innerHTML = `<div class="vq-engine vq-engine-ok">
                    <span class="vq-dot"></span>
                    <span class="vq-engine-title">Engine ready</span>
                    <span class="vq-engine-sub">${s.source === 'system' ? 'System install' : 'Bundled build'} · v${esc(s.version || '?')}</span>
                    <button type="button" class="hotkey-bind no-drag ml-auto" onclick="vcRecheck()" title="Re-detect FFmpeg">Re-detect</button>
                </div>`;
                return;
            }
            if (s.status === 'installing') {
                const pct = s.totalBytes > 0 ? Math.round((s.receivedBytes / s.totalBytes) * 100) : 0;
                const phase = s.phase === 'download' ? `Downloading FFmpeg… ${pct}% (${vcFmtBytes(s.receivedBytes)}${s.totalBytes ? ' / ' + vcFmtBytes(s.totalBytes) : ''})`
                    : s.phase === 'extract' ? 'Extracting…' : 'Validating…';
                el.innerHTML = `<div class="vq-engine vq-engine-info flex-col !items-stretch gap-2">
                    <div class="flex items-center gap-2"><i class="fas fa-download"></i><span>${esc(phase)}</span></div>
                    <div class="vq-bar"><div class="vq-bar-fill" style="width:${s.phase === 'download' ? pct : 100}%"></div></div>
                </div>`;
                return;
            }
            // missing / broken / error
            const detail = s.status === 'missing'
                ? 'A capable FFmpeg (with VMAF) wasn\'t found. Download the bundled build to enable exports — it\'s a one-time ~170 MB download.'
                : `The FFmpeg found isn't usable: ${esc(s.detail || 'unknown error')}. Install the bundled build to fix it.`;
            el.innerHTML = `<div class="vq-engine vq-engine-warn flex-col !items-stretch gap-2">
                <div class="flex items-start gap-2"><i class="fas fa-triangle-exclamation mt-0.5"></i><span>${detail}</span></div>
                <div class="flex items-center gap-2">
                    <button type="button" class="vq-btn-primary no-drag" onclick="vcSetup()"><i class="fas fa-download mr-1.5"></i>Set up the encoder</button>
                    <button type="button" class="hotkey-bind no-drag" onclick="vcRecheck()">Re-detect</button>
                </div>
            </div>`;
        }

        async function vcSetup() { if (window.electronAPI?.valclipsFfmpegSetup) await window.electronAPI.valclipsFfmpegSetup(); }
        async function vcRecheck() {
            if (!window.electronAPI?.valclipsFfmpegRecheck) return;
            await window.electronAPI.valclipsFfmpegRecheck();
            showToast('FFmpeg re-checked');
        }

        // ── Output format / mode quick toggles + drop zone ──
        function vcRenderControls() {
            const el = document.getElementById('vq-controls');
            if (!el) return;
            const st = vcq.settings || {};
            const ready = vcEngineReady();
            const orient = st.orientation || 'maintain';
            const mode = st.outputMode || 'smart';
            const seg = (val, cur, label, onClick, title) =>
                `<button type="button" title="${esc(title || '')}" class="vq-seg ${val === cur ? 'vq-seg-on' : ''} no-drag" onclick="${onClick}">${esc(label)}</button>`;

            el.innerHTML = `
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div class="flex items-center gap-2">
                        <span class="vq-seg-label">Format</span>
                        <div class="vq-seg-group">
                            ${seg('maintain', orient, 'Keep aspect', "vcSetOrientation('maintain')", 'Keep the source aspect ratio — no padding or cropping (4K/1440p still downscaled)')}
                            ${seg('vertical', orient, '9:16', "vcSetOrientation('vertical')", 'Force vertical 1080×1920 — mismatched sources get a blurred pad')}
                            ${seg('horizontal', orient, '16:9', "vcSetOrientation('horizontal')", 'Force horizontal 1920×1080 — mismatched sources get a blurred pad')}
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="vq-seg-label">Mode</span>
                        <div class="vq-seg-group">
                            ${seg('sizecap', mode, `Fit ≤ ${st.targetSizeMB || 28}MB`, "vcSetMode('sizecap')", `Crush every clip to below ${st.targetSizeMB || 28} MB (2-pass, quality-max within budget)`)}
                            ${seg('master', mode, 'Master', "vcSetMode('master')", 'Near-lossless big file (CRF 12)')}
                            ${seg('smart', mode, 'Smart Compress', "vcSetMode('smart')", 'Smallest file that still looks identical (VMAF-verified)')}
                        </div>
                    </div>
                    <button type="button" class="hotkey-bind no-drag ml-auto" onclick="vcToggleSettings()"><i class="fas fa-gear mr-1"></i>Settings</button>
                </div>
                <div id="vq-dropzone" class="vq-dropzone ${ready ? '' : 'vq-dropzone-disabled'} no-drag mt-3">
                    <i class="fas fa-clapperboard vq-dropzone-icon"></i>
                    <div class="vq-dropzone-title">${ready ? 'Drop a Valorant edit here' : 'Set up the encoder to start'}</div>
                    <div class="vq-dropzone-sub">${ready ? 'or click to browse · mp4, mov, mkv, avi, webm, m4v' : 'the FFmpeg engine must be ready first'}</div>
                </div>`;

            const dz = document.getElementById('vq-dropzone');
            if (dz && ready) vcBindDropzone(dz);
        }

        async function vcSetOrientation(v) { vcq.settings = await window.electronAPI.valclipsSettingsSet({ orientation: v }); vcRenderControls(); vcRenderSettings(); }
        async function vcSetMode(v) { vcq.settings = await window.electronAPI.valclipsSettingsSet({ outputMode: v }); vcRenderControls(); vcRenderSettings(); }

        function vcBindDropzone(dz) {
            dz.addEventListener('click', () => vcBrowse());
            dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('vq-dropzone-over'); });
            dz.addEventListener('dragleave', () => dz.classList.remove('vq-dropzone-over'));
            dz.addEventListener('drop', (e) => {
                e.preventDefault();
                dz.classList.remove('vq-dropzone-over');
                const paths = [];
                for (const f of e.dataTransfer.files) {
                    const p = window.electronAPI?.valclipsPathForFile ? window.electronAPI.valclipsPathForFile(f) : '';
                    if (p) paths.push(p);
                }
                if (paths.length) vcAdd(paths);
            });
        }

        async function vcBrowse() {
            if (!window.electronAPI?.valclipsFilesOpenDialog) return;
            const res = await window.electronAPI.valclipsFilesOpenDialog();
            vcHandleAddResult(res);
        }
        async function vcAdd(paths, overwriteConfirmed = false) {
            const res = await window.electronAPI.valclipsFilesAdd(paths, overwriteConfirmed);
            vcHandleAddResult(res);
        }
        function vcHandleAddResult(res) {
            if (!res) return;
            if (res.accepted && res.accepted.length) showToast(`Queued ${res.accepted.length} clip${res.accepted.length > 1 ? 's' : ''}`);
            for (const r of (res.rejected || [])) showToast(r.reason, true);
            if (res.needsConfirm && res.needsConfirm.length) vcConfirmOverwrite(res.needsConfirm);
            if (res.needsSelection && res.needsSelection.length) vcSelectFromFolder(res.needsSelection[0]);
        }

        function vcConfirmOverwrite(items) {
            const list = items.map((i) => esc(i.outputPath)).join('<br>');
            vcModal(`<div class="vq-modal-card">
                <div class="vq-modal-title">Output already exists</div>
                <div class="vq-modal-mono">${list}</div>
                <p class="vq-modal-note">A previous export with this name exists. Overwrite it with the new result?</p>
                <div class="vq-modal-actions">
                    <button type="button" class="hotkey-bind no-drag" onclick="vcCloseModal()">Keep old file</button>
                    <button type="button" class="vq-btn-primary no-drag" onclick="vcDoOverwrite()">Overwrite</button>
                </div>
            </div>`);
            vcModal._pending = items.map((i) => i.path);
        }
        function vcDoOverwrite() { const paths = vcModal._pending || []; vcCloseModal(); if (paths.length) vcAdd(paths, true); }

        function vcSelectFromFolder(sel) {
            const rows = sel.files.map((f) => {
                const name = f.split(/[\\/]/).pop() || f;
                return `<label class="vq-check-row"><input type="checkbox" checked data-path="${esc(f)}"><span>${esc(name)}</span></label>`;
            }).join('');
            vcModal(`<div class="vq-modal-card">
                <div class="vq-modal-title">This folder has ${sel.files.length} videos — which ones?</div>
                <div class="vq-modal-mono">${esc(sel.folder)}</div>
                <div class="vq-check-list">${rows}</div>
                <div class="vq-modal-actions">
                    <button type="button" class="hotkey-bind no-drag" onclick="vcCloseModal()">Cancel</button>
                    <button type="button" class="vq-btn-primary no-drag" onclick="vcQueueSelected()">Queue selected</button>
                </div>
            </div>`);
        }
        function vcQueueSelected() {
            const paths = [...document.querySelectorAll('.vq-check-list input:checked')].map((c) => c.getAttribute('data-path'));
            vcCloseModal();
            if (paths.length) vcAdd(paths);
        }

        // ── Job list ──
        const VC_STATUS_META = {
            queued: { label: 'Queued', cls: 'vq-badge-neutral' },
            analyzing: { label: 'Analyzing', cls: 'vq-badge-teal' },
            ready: { label: 'Ready', cls: 'vq-badge-teal' },
            processing: { label: 'Encoding', cls: 'vq-badge-accent' },
            verifying: { label: 'Verifying', cls: 'vq-badge-warn' },
            done: { label: 'Done', cls: 'vq-badge-ok' },
            error: { label: 'Failed', cls: 'vq-badge-accent' },
            cancelled: { label: 'Cancelled', cls: 'vq-badge-neutral' }
        };

        function vcRenderJobs() {
            const el = document.getElementById('vq-jobs');
            if (!el) return;
            const jobs = vcq.jobs || [];
            if (jobs.length === 0) { el.innerHTML = ''; return; }
            const finished = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.status)).length;
            el.innerHTML = `
                <div class="flex items-center justify-between mt-1 mb-1.5">
                    <span class="vq-seg-label">Queue · ${jobs.length}</span>
                    ${finished > 0 ? `<button type="button" class="vq-link no-drag" onclick="vcClearFinished()">Clear finished</button>` : ''}
                </div>
                <div class="flex flex-col gap-2">${jobs.map(vcJobRowHtml).join('')}</div>`;
        }

        function vcBadges(analysis) {
            const v = analysis.probe.video;
            const b = [];
            b.push({ t: `${v.width}×${v.height}`, c: (v.width === 1080 && v.height === 1920) ? 'vq-badge-ok' : 'vq-badge-neutral' });
            b.push({ t: `${v.fpsAverage.toFixed(v.fpsAverage % 1 ? 2 : 0)} fps`, c: 'vq-badge-neutral' });
            if (v.fpsMode === 'vfr') b.push({ t: '⚠ VFR', c: 'vq-badge-warn' });
            if (v.isHdr) b.push({ t: 'HDR', c: 'vq-badge-warn' });
            if (v.rotation !== 0) b.push({ t: `↻ ${v.rotation}°`, c: 'vq-badge-warn' });
            if (analysis.noise.noiseClass === 'heavy') b.push({ t: 'Heavy grain', c: 'vq-badge-accent' });
            else if (analysis.noise.noiseClass === 'light') b.push({ t: 'Light grain', c: 'vq-badge-warn' });
            else b.push({ t: 'Clean', c: 'vq-badge-ok' });
            b.push({ t: analysis.noise.motionClass === 'high' ? 'High motion' : 'Low motion', c: 'vq-badge-teal' });
            if (analysis.probe.durationSec > 60) b.push({ t: `⚠ ${Math.round(analysis.probe.durationSec)}s`, c: 'vq-badge-warn' });
            return b.map((x) => `<span class="vq-badge ${x.c}">${esc(x.t)}</span>`).join('');
        }

        function vcResultSummary(job) {
            const r = job.result;
            // In Fit-size mode the gauge tracks the size cap; otherwise TikTok's limit.
            const isCap = job.plan && job.plan.encode && job.plan.encode.outputMode === 'sizecap';
            const limit = isCap ? ((vcq.settings && vcq.settings.targetSizeMB || 28) * 1000000) : TIKTOK_SIZE_LIMIT;
            const frac = Math.min(1, r.sizeBytes / limit);
            const gauge = frac < 0.5 ? 'vq-gauge-ok' : frac < 0.8 ? 'vq-gauge-warn' : 'vq-gauge-accent';
            let out = `<div class="vq-result">
                <span class="vq-mono-strong">${vcFmtBytes(r.sizeBytes)}</span>
                <span class="vq-gauge" title="${isCap ? `Cap ${vcFmtBytes(limit)}` : `TikTok limit ~${vcFmtBytes(TIKTOK_SIZE_LIMIT)}`}"><span class="vq-gauge-fill ${gauge}" style="width:${Math.max(4, frac * 100)}%"></span></span>`;
            if (r.wasRemux) out += `<span class="vq-badge vq-badge-ok">lossless remux</span>`;
            if (r.vmaf !== null && r.vmaf !== undefined) out += `<span class="vq-badge vq-badge-teal" title="Measured vs the filtered source">VMAF ${r.vmaf.toFixed(1)}</span>`;
            if (r.finalCrf !== null && r.finalCrf !== undefined) out += `<span class="vq-badge vq-badge-neutral">CRF ${r.finalCrf}</span>`;
            if (r.compressionPercent && r.compressionPercent > 0) out += `<span class="vq-badge vq-badge-ok">−${r.compressionPercent}% size</span>`;
            out += `</div>`;
            return out;
        }

        function vcAnalysisDetail(job) {
            const a = job.analysis; const plan = job.plan;
            if (!a) return '';
            const p = a.probe;
            const rows = [
                ['Codec', `${p.video.codec} ${p.video.profile} · ${p.video.pixFmt} · ${p.video.bitDepth}-bit`],
                ['Color', `${p.video.colorSpace || 'untagged'} / ${p.video.colorTransfer || '—'} / ${p.video.colorPrimaries || '—'}`],
                ['Duration', vcFmtDuration(p.durationSec)],
                ['Size', `${vcFmtBytes(p.sizeBytes)} · ${(p.overallBitrate / 1000000).toFixed(1)} Mbps`],
                ['Audio', p.audio.present ? `${p.audio.codec} · ${p.audio.channels}ch · ${(p.audio.sampleRate / 1000).toFixed(1)} kHz` : 'none'],
                ['Noise / motion', `${a.noise.noiseLevel} (${a.noise.noiseClass}) / ${a.noise.motionLevel} (${a.noise.motionClass})`]
            ];
            const rowHtml = rows.map(([k, v]) => `<div class="vq-kv"><span>${esc(k)}</span><span class="vq-mono">${esc(v)}</span></div>`).join('');
            const warns = (a.warnings || []).map((w) => `<div class="vq-warn-line">⚠ ${esc(w)}</div>`).join('');
            const planHtml = plan ? `<div class="vq-plan">
                <div class="vq-plan-title">${plan.mode === 'remux' ? 'Plan: lossless remux' : 'Plan: full quality pipeline'}</div>
                <ul class="vq-plan-list">${plan.reasons.map((r) => `<li>• ${esc(r)}</li>`).join('')}</ul>
            </div>` : '';
            return `<div class="vq-detail"><div class="vq-kv-grid">${rowHtml}</div>${warns ? `<div class="vq-warns">${warns}</div>` : ''}${planHtml}</div>`;
        }

        function vcQualityReport(job) {
            const r = job.result;
            if (!r) return '';
            const verdict = r.vmaf !== null && r.vmaf !== undefined ? vcVerdict(r.vmaf) : null;
            const bitrate = job.analysis && job.analysis.probe.durationSec > 0
                ? ((r.sizeBytes * 8) / job.analysis.probe.durationSec / 1000000).toFixed(1) : null;
            const stats = [];
            stats.push(['Size', vcFmtBytes(r.sizeBytes)]);
            if (bitrate) stats.push(['Bitrate', `${bitrate} Mbps`]);
            if (r.ssim !== null && r.ssim !== undefined) stats.push(['SSIM', r.ssim.toFixed(4)]);
            if (r.finalCrf !== null && r.finalCrf !== undefined) stats.push(['Final CRF', String(r.finalCrf)]);
            if (r.compressionPercent && r.compressionPercent > 0) stats.push(['Saved', `${r.compressionPercent}% smaller`]);
            const statHtml = stats.map(([k, v]) => `<div class="vq-kv"><span>${esc(k)}</span><span class="vq-mono">${esc(v)}</span></div>`).join('');
            return `<div class="vq-detail">
                ${verdict ? `<div class="vq-verdict"><span class="vq-verdict-strong">VMAF ${r.vmaf.toFixed(1)}</span> <span class="${verdict.cls}">— ${esc(verdict.text)}</span></div>` : ''}
                <div class="vq-kv-grid vq-kv-grid-4">${statHtml}</div>
                <div class="vq-cmd-row">
                    <code class="vq-cmd" title="${esc(r.ffmpegCommand)}">${esc(r.ffmpegCommand)}</code>
                    <button type="button" class="hotkey-bind no-drag" onclick="vcCopyCmd(${jsAttr(job.id)})">Copy</button>
                </div>
            </div>`;
        }
        function vcVerdict(vmaf) {
            if (vmaf >= 97) return { text: 'indistinguishable from source', cls: 'vq-txt-ok' };
            if (vmaf >= 93) return { text: 'virtually identical — differences invisible at phone size', cls: 'vq-txt-ok' };
            if (vmaf >= 85) return { text: 'minor differences visible on close inspection', cls: 'vq-txt-warn' };
            return { text: 'visible quality loss — consider Master mode', cls: 'vq-txt-accent' };
        }
        function vcCopyCmd(id) {
            const job = (vcq.jobs || []).find((j) => j.id === id);
            if (job && job.result) { navigator.clipboard.writeText(job.result.ffmpegCommand); showToast('FFmpeg command copied'); }
        }

        const VC_CHECKLIST = [
            ['Upload via tiktok.com on desktop', 'The web uploader takes the file with far less preprocessing than the phone app.'],
            ['Enable "Upload HD" before posting', 'Toggle it in the upload dialog every time — it is off by default and it is the single biggest quality switch.'],
            ['Never add TikTok text/filters/stickers afterward', 'Any in-app edit forces a second re-encode of the whole video. Bake text into the edit instead.'],
            ['Judge quality only 30–60 min after posting', 'TikTok serves a low-res version first while the HD rendition processes.']
        ];
        function vcChecklistHtml(job) {
            const open = vcq.checklist.has(job.id);
            const items = VC_CHECKLIST.map(([t, d], i) => `<li class="vq-cl-item"><span class="vq-cl-num">${i + 1}.</span><span><span class="vq-cl-title">${esc(t)}</span><br><span class="vq-cl-detail">${esc(d)}</span></span></li>`).join('');
            return `<div class="vq-checklist">
                <button type="button" class="vq-checklist-toggle no-drag" onclick="vcToggleChecklist(${jsAttr(job.id)})">📋 Upload checklist — don't lose quality at the last step ${open ? '▲' : '▼'}</button>
                ${open ? `<ol class="vq-cl-list">${items}</ol>` : ''}
            </div>`;
        }
        function vcToggleChecklist(id) { if (vcq.checklist.has(id)) vcq.checklist.delete(id); else vcq.checklist.add(id); vcRenderJobs(); }

        function vcJobRowHtml(job) {
            const meta = VC_STATUS_META[job.status] || VC_STATUS_META.queued;
            const busy = ['analyzing', 'processing', 'verifying'].includes(job.status);
            const expanded = vcq.expanded.has(job.id);
            let inner = `<div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="vq-job-name" title="${esc(job.inputPath)}">${esc(job.fileName)}</span>
                        <span class="vq-badge ${meta.cls}">${esc(meta.label)}</span>
                        ${job.analysis ? `<button type="button" class="vq-link no-drag" onclick="vcToggleExpand(${jsAttr(job.id)})">${expanded ? '▲ hide' : '▼ details'}</button>` : ''}
                    </div>
                    <div class="vq-job-note"><span class="truncate">${esc(job.note || '')}</span>${job.analysis ? ` · ${vcFmtDuration(job.analysis.probe.durationSec)} · ${vcFmtBytes(job.analysis.probe.sizeBytes)}` : ''}${!busy && job.elapsedMs ? ` · <span class="vq-mono" title="Total process time"><i class="fas fa-stopwatch mr-1"></i>${vcFmtElapsed(job.elapsedMs)}</span>` : ''}</div>`;

            if (job.analysis) inner += `<div class="mt-1.5 flex flex-wrap items-center gap-1.5">${vcBadges(job.analysis)}</div>`;

            if (busy && job.progress) {
                const p = job.progress;
                const meta2 = [];
                if (p.fps > 0) meta2.push(`${p.fps.toFixed(0)} fps`);
                // Total estimated time for the current step, shown with the bar.
                const totalSec = p.totalSec || (p.etaSec > 0 ? p.etaSec : 0);
                if (totalSec > 0) meta2.push(`~${vcFmtDuration(totalSec)} total`);
                meta2.push(`${p.percent.toFixed(0)}%`);
                inner += `<div class="mt-2">
                    <div class="vq-prog-head"><span>${esc(p.stage)}</span><span class="vq-mono">${meta2.join(' · ')}</span></div>
                    <div class="vq-bar mt-1"><div class="vq-bar-fill vq-bar-grad" style="width:${Math.min(100, p.percent)}%"></div></div>
                </div>`;
            }
            if (job.status === 'error' && job.error) inner += `<div class="vq-error-line">${esc(job.error)}</div>`;
            if (job.status === 'done' && job.result) inner += vcResultSummary(job);
            if (job.status === 'done') inner += vcChecklistHtml(job);
            if (expanded && job.status === 'done' && job.result && !job.result.wasRemux) inner += vcQualityReport(job);
            if (expanded && job.analysis) inner += vcAnalysisDetail(job);

            inner += `</div><div class="flex shrink-0 flex-col items-end gap-1.5">`;
            if (busy || job.status === 'queued') inner += `<button type="button" class="hotkey-bind no-drag" onclick="vcCancel(${jsAttr(job.id)})">Cancel</button>`;
            if (job.analysis && !busy) inner += `<button type="button" class="hotkey-bind no-drag" title="Manual sliders + live before/after preview" onclick="vcOpenTune(${jsAttr(job.id)})">Tune${job.overrides ? ' •' : ''}</button>`;
            if (job.status === 'done' && job.result) {
                inner += `<button type="button" class="hotkey-bind no-drag" title="Wipe / side-by-side at the highest-motion moments" onclick="vcOpenCompare(${jsAttr(job.id)})">Compare</button>`;
                inner += `<button type="button" class="hotkey-bind no-drag" onclick="vcShowFile(${jsAttr(job.id)})">Show file</button>`;
            }
            if (!busy) inner += `<button type="button" class="vq-x no-drag" title="Remove from queue" onclick="vcRemove(${jsAttr(job.id)})">✕</button>`;
            inner += `</div></div>`;
            return `<div class="vq-job">${inner}</div>`;
        }

        function vcToggleExpand(id) { if (vcq.expanded.has(id)) vcq.expanded.delete(id); else vcq.expanded.add(id); vcRenderJobs(); }
        function vcCancel(id) { window.electronAPI.valclipsJobsCancel(id); }
        function vcRemove(id) { window.electronAPI.valclipsJobsRemove(id); }
        function vcClearFinished() { window.electronAPI.valclipsJobsClearFinished(); }
        function vcShowFile(id) { const job = (vcq.jobs || []).find((j) => j.id === id); if (job && job.result) window.electronAPI.valclipsShowInFolder(job.result.outputPath); }

        // ── Inline settings drawer ──
        let vcSettingsOpen = false;
        function vcToggleSettings() { vcSettingsOpen = !vcSettingsOpen; vcRenderSettings(); }
        function vcRenderSettings() {
            const el = document.getElementById('vq-settings-wrap');
            if (!el) return;
            if (!vcSettingsOpen) { el.innerHTML = ''; return; }
            const s = vcq.settings || {};
            const row = (label, hint, control) => `<div class="vq-set-row"><div class="min-w-0 flex-1"><div class="vq-set-label">${label}</div>${hint ? `<div class="vq-set-hint">${hint}</div>` : ''}</div><div class="shrink-0">${control}</div></div>`;
            const toggle = (id, on) => `<span class="ios-toggle"><input type="checkbox" id="${id}" class="ios-toggle-input" ${on ? 'checked' : ''}><span class="ios-toggle-track"></span></span>`;
            el.innerHTML = `<div class="vq-settings">
                <div class="vq-set-section">Output quality</div>
                ${row('Master CRF', 'Lower = higher quality, bigger file (10–16).', `<span class="vq-range-wrap"><input type="range" min="10" max="16" step="1" value="${s.masterCrf || 12}" id="vq-crf" class="vq-range"><span class="vq-mono" id="vq-crf-val">${s.masterCrf || 12}</span></span>`)}
                ${row('Smart target — VMAF', '97+ is visually lossless for high-motion gameplay.', `<span class="vq-range-wrap"><input type="range" min="90" max="99" step="1" value="${s.vmafTarget || 97}" id="vq-vmaf" class="vq-range"><span class="vq-mono" id="vq-vmaf-val">${s.vmafTarget || 97}</span></span>`)}
                ${row('Loudness normalize audio', 'Two-pass loudnorm to −14 LUFS / −1 dBTP.', toggle('vq-loud', s.loudnorm !== false))}
                <div class="vq-set-section">Fit size (≤ cap)</div>
                ${row('Target max size (MB)', 'Fit-size mode crushes every export to below this (2-pass).', `<input type="number" min="1" max="2000" id="vq-target" class="vq-input" style="width:90px" value="${s.targetSizeMB || 28}">`)}
                ${row('Max input size (MB)', 'Files larger than this are rejected before encoding.', `<input type="number" min="1" max="100000" id="vq-maxin" class="vq-input" style="width:90px" value="${s.maxInputSizeMB || 500}">`)}
                <div class="vq-set-section">Files</div>
                ${row('Confirm before overwriting', 'Ask when a _output.mp4 already exists.', toggle('vq-confirm', s.confirmOverwrite !== false))}
                ${row('Filename template', '{name} is the source name. Output is always .mp4.', `<input type="text" id="vq-template" class="vq-input" value="${esc(s.filenameTemplate || '{name}_output')}">`)}
                ${row('Output folder', esc(s.outputFolder || 'Next to each source file (default)'), `<span class="flex gap-2"><button type="button" class="hotkey-bind no-drag" onclick="vcPickFolder()">Choose…</button>${s.outputFolder ? `<button type="button" class="hotkey-bind no-drag" onclick="vcResetFolder()">Reset</button>` : ''}</span>`)}
                <div class="vq-set-section">Advanced</div>
                ${row('Hardware-accelerated previews (NVENC)', 'Preview rendering only — exports always use software x264.', toggle('vq-hw', !!s.hardwarePreview))}
                ${row('TikTok target spec', 'Resolution, fps & bitrate bounds — editable JSON.', `<button type="button" class="hotkey-bind no-drag" onclick="vcOpenSettingsFile()">Open settings.json</button>`)}
                ${vcEngineReady() ? `<div class="vq-set-section">FFmpeg engine</div>${row('Bundled build', esc((vcq.ffmpeg && vcq.ffmpeg.ffmpegPath) || ''), `<button type="button" class="hotkey-bind no-drag" onclick="vcSetup()">Reinstall</button>`)}` : ''}
            </div>`;

            const bindRange = (id, valId, key, cb) => {
                const inp = document.getElementById(id);
                const out = document.getElementById(valId);
                if (!inp) return;
                inp.addEventListener('input', () => { if (out) out.textContent = inp.value; });
                inp.addEventListener('change', async () => { vcq.settings = await window.electronAPI.valclipsSettingsSet({ [key]: parseInt(inp.value, 10) }); if (cb) cb(); });
            };
            bindRange('vq-crf', 'vq-crf-val', 'masterCrf');
            bindRange('vq-vmaf', 'vq-vmaf-val', 'vmafTarget');
            const bindToggle = (id, key) => { const c = document.getElementById(id); if (c) c.addEventListener('change', async () => { vcq.settings = await window.electronAPI.valclipsSettingsSet({ [key]: c.checked }); }); };
            bindToggle('vq-loud', 'loudnorm');
            bindToggle('vq-confirm', 'confirmOverwrite');
            bindToggle('vq-hw', 'hardwarePreview');
            const tpl = document.getElementById('vq-template');
            if (tpl) tpl.addEventListener('change', async () => { vcq.settings = await window.electronAPI.valclipsSettingsSet({ filenameTemplate: tpl.value }); });
            const bindNum = (id, key, def) => {
                const inp = document.getElementById(id);
                if (!inp) return;
                inp.addEventListener('change', async () => {
                    vcq.settings = await window.electronAPI.valclipsSettingsSet({ [key]: parseInt(inp.value, 10) || def });
                    vcRenderControls(); // the Fit-size mode label shows the target size
                    vcRenderSettings(); // reflect the clamped value
                });
            };
            bindNum('vq-target', 'targetSizeMB', 28);
            bindNum('vq-maxin', 'maxInputSizeMB', 500);
        }
        async function vcPickFolder() { vcq.settings = await window.electronAPI.valclipsSettingsPickOutputFolder(); vcRenderSettings(); }
        async function vcResetFolder() { vcq.settings = await window.electronAPI.valclipsSettingsSet({ outputFolder: null }); vcRenderSettings(); }
        function vcOpenSettingsFile() { window.electronAPI.valclipsOpenSettingsFile(); }

        // ── Generic modal host (appended to body so it overlays the whole app) ──
        function vcModal(html) {
            vcCloseModal();
            const wrap = document.createElement('div');
            wrap.id = 'vq-modal';
            wrap.className = 'vq-modal-backdrop';
            wrap.innerHTML = html;
            wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) vcCloseModal(); });
            document.body.appendChild(wrap);
        }
        function vcCloseModal() { const m = document.getElementById('vq-modal'); if (m) m.remove(); }

        // ── Tune modal (live before/after preview + sliders) ──
        function vcOpenTune(id) {
            const job = (vcq.jobs || []).find((j) => j.id === id);
            if (!job || !job.plan) return;
            const base = job.plan.filters;
            const ov = job.overrides || {};
            vcqTune = {
                jobId: id, seq: 0, timer: null,
                denoise: ov.denoise != null ? ov.denoise : (base.denoise || 0),
                sharpen: ov.sharpen != null ? ov.sharpen : (base.sharpen != null ? base.sharpen : 0.25),
                saturation: ov.saturationBoost != null ? ov.saturationBoost : (base.saturationBoost != null ? base.saturationBoost : 1.05),
                contrast: ov.contrastBoost != null ? ov.contrastBoost : (base.contrastBoost != null ? base.contrastBoost : 1.02),
                scaleMode: (ov.scale && ov.scale.mode) || (base.scale && base.scale.mode === 'fill-crop' ? 'fill-crop' : 'fit-pad'),
                minterpolate: ov.minterpolate != null ? ov.minterpolate : !!base.minterpolate
            };
            vcRenderTune();
            vcTuneSchedule();
        }
        function vcTuneOverrides() {
            const t = vcqTune;
            const job = (vcq.jobs || []).find((j) => j.id === t.jobId);
            const base = job && job.plan ? job.plan.filters : null;
            const o = {
                denoise: t.denoise,
                denoiseFilter: t.denoise <= 0 ? 'none' : (t.denoise > 55 ? 'nlmeans' : 'hqdn3d'),
                sharpen: t.sharpen, saturationBoost: t.saturation, contrastBoost: t.contrast, minterpolate: t.minterpolate
            };
            if (base && base.scale && base.scale.mode !== 'none') o.scale = { ...base.scale, mode: t.scaleMode };
            return o;
        }
        function vcRenderTune() {
            const t = vcqTune;
            const job = (vcq.jobs || []).find((j) => j.id === t.jobId);
            if (!job) return;
            const base = job.plan ? job.plan.filters : null;
            const showScale = !!(base && base.scale && base.scale.mode !== 'none');
            const aspect = base && base.scale ? `${base.scale.targetW}/${base.scale.targetH}`
                : job.analysis ? `${job.analysis.probe.video.width}/${job.analysis.probe.video.height}` : '9/16';
            const finished = ['done', 'error', 'cancelled'].includes(job.status);
            vcModal(`<div class="vq-modal-card vq-tune-card">
                <div class="vq-tune-head">
                    <div><div class="vq-modal-title">Tune — ${esc(job.fileName)}</div><div class="vq-set-hint">Preview shows the real filter chain on a 2-second slice.</div></div>
                    <button type="button" class="vq-x no-drag ml-auto" onclick="vcCloseModal()">✕</button>
                </div>
                <div class="vq-tune-body">
                    <div class="vq-tune-previews">
                        <div><div class="vq-tune-pv-label">Before</div><div class="vq-tune-pv" style="aspect-ratio:${aspect}"><video id="vq-pv-before" autoplay loop muted></video><div class="vq-tune-pv-empty" id="vq-pv-before-empty">rendering…</div></div></div>
                        <div><div class="vq-tune-pv-label">After</div><div class="vq-tune-pv" style="aspect-ratio:${aspect}"><video id="vq-pv-after" autoplay loop muted></video><div class="vq-tune-pv-empty" id="vq-pv-after-empty">rendering…</div><div class="vq-shimmer" id="vq-pv-shimmer"></div></div></div>
                    </div>
                    <div class="vq-tune-sliders">
                        <div class="vq-slider-block">
                            <div class="vq-slider-head"><span>Particle &amp; noise cleanup</span><span class="vq-mono vq-txt-teal" id="vq-t-denoise-val"></span></div>
                            <input type="range" min="0" max="100" step="1" value="${t.denoise}" id="vq-t-denoise" class="vq-range">
                            <p class="vq-set-hint">Removes random grain that wastes TikTok bitrate. Too high softens VFX — muzzle flashes, ability particles. When in doubt, keep it low.</p>
                        </div>
                        <div class="vq-slider-block">
                            <div class="vq-slider-head"><span>Pre-sharpen</span><span class="vq-mono vq-txt-teal" id="vq-t-sharpen-val"></span></div>
                            <input type="range" min="0" max="0.8" step="0.05" value="${t.sharpen}" id="vq-t-sharpen" class="vq-range">
                            <p class="vq-set-hint">Counters TikTok's softening. Subtle is best — halos look worse than softness.</p>
                        </div>
                        <div class="vq-slider-block">
                            <div class="vq-slider-head"><span>Saturation</span><span class="vq-mono vq-txt-teal" id="vq-t-sat-val"></span></div>
                            <input type="range" min="1" max="1.25" step="0.01" value="${t.saturation}" id="vq-t-sat" class="vq-range">
                        </div>
                        <div class="vq-slider-block">
                            <div class="vq-slider-head"><span>Contrast</span><span class="vq-mono vq-txt-teal" id="vq-t-con-val"></span></div>
                            <input type="range" min="1" max="1.15" step="0.01" value="${t.contrast}" id="vq-t-con" class="vq-range">
                        </div>
                        ${showScale ? `<div class="vq-slider-block">
                            <div class="vq-slider-head"><span>Aspect framing</span></div>
                            <div class="vq-seg-group vq-seg-group-full">
                                <button type="button" class="vq-seg ${t.scaleMode === 'fit-pad' ? 'vq-seg-on' : ''} no-drag" onclick="vcTuneScale('fit-pad')">Fit + blurred pad</button>
                                <button type="button" class="vq-seg ${t.scaleMode === 'fill-crop' ? 'vq-seg-on' : ''} no-drag" onclick="vcTuneScale('fill-crop')">Fill (crop sides)</button>
                            </div>
                            <p class="vq-set-hint">Never stretched, ever.</p>
                        </div>` : ''}
                        <label class="vq-mint">
                            <span class="ios-toggle"><input type="checkbox" id="vq-t-mint" class="ios-toggle-input" ${t.minterpolate ? 'checked' : ''}><span class="ios-toggle-track"></span></span>
                            <span><span class="vq-cl-title">Experimental: motion-interpolated ${base && base.fpsTarget ? base.fpsTarget : 60} fps</span><br>Generates in-between frames instead of duplicating. <span class="vq-txt-warn">Interpolation smears fast flicks.</span></span>
                        </label>
                    </div>
                </div>
                <div class="vq-tune-foot">
                    <button type="button" class="hotkey-bind no-drag" onclick="vcTuneReset()">Reset to automatic</button>
                    <div class="ml-auto flex gap-2">
                        <button type="button" class="hotkey-bind no-drag" onclick="vcCloseModal()">Cancel</button>
                        <button type="button" class="vq-btn-primary no-drag" onclick="vcTuneApply()">${finished ? 'Apply & re-process' : 'Apply'}</button>
                    </div>
                </div>
            </div>`);
            vcTuneBind();
            vcTuneUpdateLabels();
        }
        function vcTuneBind() {
            const on = (id, prop, parse) => { const inp = document.getElementById(id); if (!inp) return; inp.addEventListener('input', () => { vcqTune[prop] = parse(inp.value); vcTuneUpdateLabels(); vcTuneSchedule(); }); };
            on('vq-t-denoise', 'denoise', (v) => parseInt(v, 10));
            on('vq-t-sharpen', 'sharpen', parseFloat);
            on('vq-t-sat', 'saturation', parseFloat);
            on('vq-t-con', 'contrast', parseFloat);
            const mint = document.getElementById('vq-t-mint');
            if (mint) mint.addEventListener('change', () => { vcqTune.minterpolate = mint.checked; vcTuneSchedule(); });
        }
        function vcTuneUpdateLabels() {
            const t = vcqTune;
            const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
            set('vq-t-denoise-val', t.denoise === 0 ? 'off' : `${t.denoise} · ${t.denoise > 55 ? 'nlmeans' : 'hqdn3d'}`);
            set('vq-t-sharpen-val', t.sharpen.toFixed(2));
            set('vq-t-sat-val', `${t.saturation.toFixed(2)}×`);
            set('vq-t-con-val', `${t.contrast.toFixed(2)}×`);
        }
        function vcTuneScale(mode) { vcqTune.scaleMode = mode; vcRenderTune(); vcTuneSchedule(); }
        function vcTuneSchedule() {
            const t = vcqTune;
            if (!t) return;
            const shimmer = document.getElementById('vq-pv-shimmer');
            if (shimmer) shimmer.style.display = 'block';
            if (t.timer) clearTimeout(t.timer);
            t.timer = setTimeout(async () => {
                const mySeq = ++t.seq;
                try {
                    const res = await window.electronAPI.valclipsPreviewGenerate(t.jobId, vcTuneOverrides());
                    if (t.seq !== mySeq || !document.getElementById('vq-pv-before')) return;
                    const before = document.getElementById('vq-pv-before');
                    const after = document.getElementById('vq-pv-after');
                    if (before) { before.src = res.beforeUrl; document.getElementById('vq-pv-before-empty')?.remove(); }
                    if (after) { after.src = res.afterUrl; document.getElementById('vq-pv-after-empty')?.remove(); }
                    if (shimmer) shimmer.style.display = 'none';
                } catch (err) {
                    if (t.seq === mySeq && shimmer) shimmer.style.display = 'none';
                    if (err && !String(err.message).includes('superseded')) showToast('Preview failed', true);
                }
            }, 600);
        }
        async function vcTuneApply() {
            const t = vcqTune;
            const job = (vcq.jobs || []).find((j) => j.id === t.jobId);
            await window.electronAPI.valclipsJobsSetOverrides(t.jobId, vcTuneOverrides());
            if (job && ['done', 'error', 'cancelled', 'ready'].includes(job.status)) { await window.electronAPI.valclipsJobsRequeue(t.jobId); showToast('Re-processing with your settings'); }
            else showToast('Settings will be used for this clip');
            vcqTune = null;
            vcCloseModal();
        }
        async function vcTuneReset() {
            const t = vcqTune;
            await window.electronAPI.valclipsJobsSetOverrides(t.jobId, null);
            showToast('Back to automatic settings');
            vcqTune = null;
            vcCloseModal();
        }

        // ── Compare modal (wipe / side-by-side at motion hotspots) ──
        function vcOpenCompare(id) {
            const job = (vcq.jobs || []).find((j) => j.id === id);
            if (!job || !job.result) return;
            vcqCompare = { jobId: id, spot: 0, mode: 'wipe', wipe: 50, zoom: 1, playing: true, pair: null, loading: true };
            vcRenderCompare();
            vcCompareLoad();
        }
        function vcCompareTime() {
            const job = (vcq.jobs || []).find((j) => j.id === vcqCompare.jobId);
            const hs = (job && job.result && job.result.hotspots) || [];
            return hs.length > 0 ? (hs[vcqCompare.spot] ? hs[vcqCompare.spot].timeSec : 0) : 0;
        }
        async function vcCompareLoad() {
            const c = vcqCompare;
            c.loading = true; c.pair = null;
            vcRenderCompare();
            try {
                const pair = await window.electronAPI.valclipsCompareGenerate(c.jobId, vcCompareTime());
                if (!vcqCompare || vcqCompare.jobId !== c.jobId) return;
                c.pair = pair; c.loading = false; c.playing = true;
                vcRenderCompare();
            } catch (err) {
                if (vcqCompare) { vcqCompare.loading = false; vcRenderCompare(); }
                showToast('Comparison failed', true);
            }
        }
        function vcRenderCompare() {
            const c = vcqCompare;
            if (!c) return;
            const job = (vcq.jobs || []).find((j) => j.id === c.jobId);
            if (!job) return;
            const hs = (job.result && job.result.hotspots) || [];
            const scale = job.plan && job.plan.filters.scale;
            const aspect = scale ? `${scale.targetW}/${scale.targetH}` : job.analysis ? `${job.analysis.probe.video.width}/${job.analysis.probe.video.height}` : '9/16';
            const spots = hs.length ? hs.map((h, i) => `<button type="button" class="vq-badge ${c.spot === i ? 'vq-badge-accent' : 'vq-badge-neutral'} no-drag" onclick="vcCompareSpot(${i})">🔥 ${h.timeSec.toFixed(0)}s</button>`).join('')
                : `<span class="vq-set-hint">no hotspots — showing clip start</span>`;
            const zoomStyle = c.zoom > 1 ? `transform:scale(${c.zoom});transform-origin:center` : '';
            let stage = '';
            if (c.loading) stage = `<div class="vq-set-hint">Rendering comparison at ${vcCompareTime().toFixed(0)}s…</div>`;
            else if (c.pair && c.mode === 'wipe') {
                stage = `<div class="vq-cmp-wipe" style="aspect-ratio:${aspect}">
                    <video id="vq-cmp-a" src="${esc(c.pair.expectedUrl)}" autoplay loop muted style="${zoomStyle}"></video>
                    <div class="vq-cmp-overlay" style="clip-path:inset(0 0 0 ${c.wipe}%)"><video id="vq-cmp-b" src="${esc(c.pair.actualUrl)}" autoplay loop muted style="${zoomStyle}"></video></div>
                    <div class="vq-cmp-divider" style="left:${c.wipe}%"></div>
                    <span class="vq-cmp-tag vq-cmp-tag-l vq-txt-teal">EXPECTED</span>
                    <span class="vq-cmp-tag vq-cmp-tag-r vq-txt-accent">ACTUAL</span>
                </div>`;
            } else if (c.pair) {
                stage = `<div class="vq-cmp-side">
                    <div class="vq-cmp-half" style="aspect-ratio:${aspect}"><video id="vq-cmp-a" src="${esc(c.pair.expectedUrl)}" autoplay loop muted style="${zoomStyle}"></video><span class="vq-cmp-tag vq-cmp-tag-l vq-txt-teal">EXPECTED</span></div>
                    <div class="vq-cmp-half" style="aspect-ratio:${aspect}"><video id="vq-cmp-b" src="${esc(c.pair.actualUrl)}" autoplay loop muted style="${zoomStyle}"></video><span class="vq-cmp-tag vq-cmp-tag-l vq-txt-accent">ACTUAL</span></div>
                </div>`;
            }
            vcModal(`<div class="vq-cmp">
                <div class="vq-cmp-head">
                    <div class="vq-modal-title">Compare — ${esc(job.fileName)}</div>
                    <div class="flex gap-1 flex-wrap">${spots}</div>
                    <div class="ml-auto flex items-center gap-2">
                        <div class="vq-seg-group">
                            <button type="button" class="vq-seg ${c.mode === 'wipe' ? 'vq-seg-on' : ''} no-drag" onclick="vcCompareMode('wipe')">Wipe</button>
                            <button type="button" class="vq-seg ${c.mode === 'side' ? 'vq-seg-on' : ''} no-drag" onclick="vcCompareMode('side')">Side by side</button>
                        </div>
                        <div class="vq-seg-group">
                            ${[1, 2, 3].map((z) => `<button type="button" class="vq-seg ${c.zoom === z ? 'vq-seg-on' : ''} no-drag" onclick="vcCompareZoom(${z})">${z}×</button>`).join('')}
                        </div>
                        <button type="button" class="hotkey-bind no-drag" onclick="vcCompareClose()">Close (Esc)</button>
                    </div>
                </div>
                <div class="vq-cmp-stage">${stage}</div>
                <div class="vq-cmp-foot">
                    <button type="button" class="hotkey-bind no-drag" onclick="vcCompareStep(-1)" title="Previous frame (←)">⏮ frame</button>
                    <button type="button" class="vq-btn-primary no-drag" onclick="vcCompareToggle()">${c.playing ? '⏸ Pause' : '▶ Play'}</button>
                    <button type="button" class="hotkey-bind no-drag" onclick="vcCompareStep(1)" title="Next frame (→)">frame ⏭</button>
                    ${c.mode === 'wipe' ? `<span class="vq-set-hint">wipe</span><input type="range" min="0" max="100" value="${c.wipe}" id="vq-cmp-wipe" class="vq-range flex-1">` : ''}
                    <span class="ml-auto vq-set-hint">space = play/pause · ←/→ = frame step</span>
                </div>
            </div>`);
            const wipe = document.getElementById('vq-cmp-wipe');
            if (wipe) wipe.addEventListener('input', () => {
                c.wipe = parseInt(wipe.value, 10);
                const ov = document.querySelector('.vq-cmp-overlay');
                const dv = document.querySelector('.vq-cmp-divider');
                if (ov) ov.style.clipPath = `inset(0 0 0 ${c.wipe}%)`;
                if (dv) dv.style.left = `${c.wipe}%`;
            });
            vcCompareBindKeys();
        }
        function vcCompareSpot(i) { vcqCompare.spot = i; vcCompareLoad(); }
        function vcCompareMode(m) { vcqCompare.mode = m; vcRenderCompare(); }
        function vcCompareZoom(z) { vcqCompare.zoom = z; vcRenderCompare(); }
        function vcCompareToggle() { const c = vcqCompare; c.playing = !c.playing; vcCompareSync(); const btn = document.querySelector('.vq-cmp-foot .vq-btn-primary'); if (btn) btn.innerHTML = c.playing ? '⏸ Pause' : '▶ Play'; }
        function vcCompareSync() {
            const a = document.getElementById('vq-cmp-a'), b = document.getElementById('vq-cmp-b');
            for (const v of [a, b]) { if (!v) continue; if (vcqCompare.playing) v.play().catch(() => {}); else v.pause(); }
        }
        function vcCompareStep(dir) {
            const c = vcqCompare;
            c.playing = false; vcCompareSync();
            const a = document.getElementById('vq-cmp-a'), b = document.getElementById('vq-cmp-b');
            if (!a || !b) return;
            const fps = (c.pair && c.pair.fps) || 60;
            const t = Math.max(0, Math.min(a.duration || 2, a.currentTime + dir / fps));
            a.currentTime = t; b.currentTime = t;
            const btn = document.querySelector('.vq-cmp-foot .vq-btn-primary'); if (btn) btn.innerHTML = '▶ Play';
        }
        let vcCompareKeyHandler = null;
        function vcCompareBindKeys() {
            if (vcCompareKeyHandler) return;
            vcCompareKeyHandler = (e) => {
                if (!vcqCompare || !document.getElementById('vq-modal')) return;
                if (e.key === 'ArrowRight') { e.preventDefault(); vcCompareStep(1); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); vcCompareStep(-1); }
                else if (e.key === ' ') { e.preventDefault(); vcCompareToggle(); }
                else if (e.key === 'Escape') vcCompareClose();
            };
            document.addEventListener('keydown', vcCompareKeyHandler);
        }
        function vcCompareClose() {
            vcqCompare = null;
            if (vcCompareKeyHandler) { document.removeEventListener('keydown', vcCompareKeyHandler); vcCompareKeyHandler = null; }
            vcCloseModal();
        }

        // Keep open Tune/Compare modals coherent when jobs update underneath them
        // (e.g. a re-queued clip finishes) — they re-fetch from vcq.jobs on demand,
        // so nothing to push here beyond leaving them as-is.
        function vcSyncModals() { /* modals read live from vcq.jobs; no-op */ }

        // A file dropped anywhere but a real drop target makes the Electron window
        // navigate to that file (file://) and blank the whole app. Guard it once,
        // globally — the ValClips drop zone still processes its own drops normally
        // (its handler already calls preventDefault, so this never double-fires).
        (function vcInstallDropGuard() {
            window.addEventListener('dragover', (e) => { e.preventDefault(); }, false);
            window.addEventListener('drop', (e) => {
                if (!(e.target.closest && e.target.closest('#vq-dropzone'))) e.preventDefault();
            }, false);
        })();
