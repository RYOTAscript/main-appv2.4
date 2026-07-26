# Changelog — valclips quality

## 1.2.0 (2026-07-17)

### Keep-aspect output mode (new default)
- New "Keep aspect" framing option, now the default: the source aspect ratio is preserved
  exactly — no padding, no cropping, no upscaling. Oversized sources (1440p/4K) are still
  downscaled to the 1080 class for the supersampling quality win
- "9:16 + blur" (1080×1920) and "16:9 + blur" (1920×1080) remain as secondary options that
  force the shape with the blurred-background pad
- Already-optimal detection follows the mode: in Keep aspect, any clean H.264/CFR/BT.709 clip
  at or below the 1080 class is losslessly remuxed regardless of shape
- Modified: `src/shared/types.ts`, `src/shared/decision.ts`, `src/main/pipeline.ts`,
  `src/main/settings.ts`, `src/renderer/src/pages/QueuePage.tsx`,
  `src/renderer/src/pages/SettingsPage.tsx`, tests

## 1.1.0 (2026-07-16)

### Output format: 9:16 and 16:9
- New output-format selector with two options: **9:16 vertical** (1080×1920, TikTok feed)
  and **16:9 horizontal** (1920×1080, landscape) — on the Queue page above the drop zone
  and in Settings → Output quality
- The entire pipeline follows the selected target: already-optimal detection/lossless remux,
  lanczos scaling, blurred-background padding for mismatched aspects, and the decision engine
  (a perfect 1920×1080 clip now remuxes in 16:9 mode)
- Comparison viewer and tune previews frame themselves to the selected output shape
- Modified: `src/shared/types.ts`, `src/shared/decision.ts`, `src/main/pipeline.ts`,
  `src/main/settings.ts`, `src/renderer/src/pages/QueuePage.tsx`,
  `src/renderer/src/pages/SettingsPage.tsx`, `src/renderer/src/components/CompareViewer.tsx`,
  `src/renderer/src/components/TunePanel.tsx`, tests

## 1.0.0 (2026-07-16)

First complete release, built in 6 stages.

### Stage 1 — Scaffold & foundation
- Electron + Vite + React + TypeScript + Tailwind app shell (dark glassmorphism design system)
- FFmpeg/FFprobe toolchain manager: detects system installs, validates binaries by
  actually running them (`-version`, capability probe for libx264/libvmaf/nlmeans/
  hqdn3d/zscale/unsharp), auto-downloads the full BtbN GPL build with live progress,
  clear "found but not working — replace it" recovery flow
- Drag-and-drop hero zone (.mp4/.mov/.mkv/.avi/.webm/.m4v; friendly rejection otherwise)
- Zero-config Express path: drop a file → analyze → optimal plan → encode
- Output naming: `<name>_output.mp4`, stacked `_output` suffixes stripped, overwrite confirmation
- Atomic temp-file writes everywhere; sources are never opened for writing
- Sidebar navigation, toasts, keyboard-shortcut framework

### Stage 2 — Deep analysis & decision engine
- FFprobe deep scan: resolution, exact fps, codec/profile, bit depth, color space, HDR flag,
  rotation, duration, bitrate, audio layout
- True VFR detection from packet timestamps (interval jitter), not container metadata
- Noise measurement: temporal-difference bitplane randomness (dancing grain) corroborated by
  spatial randomness — calibrated against generated fixtures; motion complexity via signalstats
- Analysis card with badges: VFR ⚠, HDR, grain class, motion class, >60 s warning
- "Already optimal" detection → lossless stream-copy remux (`-c copy +faststart`), zero
  generation loss; anything needing a fix falls through to the encode pipeline
- Decision engine as a pure function with unit-test fixtures: already-optimal → remux,
  VFR OBS, 4K60 ShadowPlay (supersampling), 16:9 Premiere export, HDR, grainy edit, 24 fps

### Stage 3 — Cleanup & prep pipeline
- Tiered particle/noise cleanup: off for clean clips, hqdn3d for light noise, nlmeans for
  heavy grain — conservative by design so Valorant VFX stay intact; 0–100 slider
- Live 2-second before/after preview through the real filter chain
- HDR → BT.709 tone-map (zscale + hable); rotation baked in
- Lanczos scaling to 1080×1920; fit with blurred-background pad or fill-crop for 16:9 — never stretch
- CFR via the `fps` filter only (never input `-r`, never timestamp tricks); optional
  experimental minterpolate (off by default — smears flicks); `aresample=async=1` A/V sync
- TikTok-crush countermeasures: post-scale luma pre-sharpen (0–0.8) + subtle saturation/contrast

### Stage 4 — Encoding engine
- Master mode: CRF 12 (10–16), software x264 veryslow, High@4.2, yuv420p, BT.709 tags in
  container *and* bitstream VUI, +faststart, size gauge vs TikTok's limit
- Smart Compress: CRF binary search (start 18) until VMAF ≥ target (default 97) —
  smallest file that is still visually lossless
- High-motion x264 tuning (every parameter documented in code): ref=6, bframes=5, b-adapt=2,
  me=umh, subme=10, merange=32, rc-lookahead=60, aq-mode=3, psy-rd=1.0,0.15, deblock=-1,-1,
  keyint=120, min-keyint=60
- Audio: AAC-LC 320k / 48 kHz stereo; optional two-pass loudnorm to −14 LUFS / −1 dBTP
- Real-time progress (fps, bitrate, speed, ETA), cancel, sequential batch queue

### Stage 5 — Verification & comparison
- Automatic VMAF + SSIM for every export with a plain-English verdict
- Master mode auto-retries at lower CRF when below target; Smart Compress adjusts its search
- Motion-hotspot detection (top-3 highest-motion seconds) feeding a comparison viewer:
  wipe slider + side-by-side, frame stepping (←/→), 1–3× zoom
- Full quality report: scores, size gauge, bitrate, exact FFmpeg command with copy button

### Stage 6 — Polish, guidance & hardening
- Post-export upload checklist (desktop upload, "Upload HD", no in-app edits, wait 30–60 min)
- Editor export settings guide (Premiere / After Effects / DaVinci)
- Hardened failure paths: every temp/partial file is deleted on any failure or cancel;
  expandable raw FFmpeg log per job; friendly errors for corrupt/unsupported files
- Multi-file drop, folder drop (single video queues directly; multiple videos ask which)
- Output folder setting, filename templates, editable TikTok spec JSON, NVENC fast previews
  (with automatic software fallback)
- End-to-end test: fixture → full pipeline → output verified CFR 60, BT.709, faststart, VMAF ≥ target
