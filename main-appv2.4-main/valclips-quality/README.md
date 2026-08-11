# valclips quality

Maximum-effort TikTok quality tool for **~20-second Valorant edits**. Drop a clip; get back a
file that survives TikTok's re-encode looking as close to your editor preview as possible.

## Run it

```
cd valclips-quality
npm install
npm start
```

Windows only. On first launch the app offers a one-time FFmpeg download (~170 MB, full build
with VMAF quality measurement) — or it uses your system FFmpeg if it has everything needed.

## How to use

1. **Drop your edit** onto the big zone (or press `Ctrl+O`). That's it — the Express path
   analyzes the clip, picks the optimal plan and encodes automatically.
2. Watch the analysis badges: VFR ⚠, HDR, grain class, resolution, fps.
3. When it's done you get a VMAF-verified file named `<name>_output.mp4` next to the source,
   plus a wipe/side-by-side **Compare** viewer at the highest-motion moments and an
   **upload checklist**.

Optional controls (never required):

- **Tune** on any clip: particle/noise cleanup slider (0–100) with live before/after preview,
  pre-sharpen, saturation/contrast, 16:9 framing choice, experimental motion interpolation.
- **Settings**: Master mode (near-lossless CRF 12) vs Smart Compress (smallest file that is
  still visually lossless, VMAF-target search), loudness normalization, output folder,
  filename template, editable TikTok spec JSON.

## What it does under the hood

| Problem | Fix |
| --- | --- |
| OBS/ShadowPlay VFR recordings | true CFR via the `fps` filter (detected from packet timestamps) |
| Grain/particle noise wasting TikTok bitrate | tiered hqdn3d/nlmeans, calibrated to spare Valorant VFX |
| HDR captures | zscale + hable tone-map to BT.709 |
| 1440p/4K sources | lanczos downscale = supersampling win |
| 16:9 sources | fit into 1080×1920 with blurred pad (never stretched) |
| TikTok softening/washing | optional pre-sharpen + subtle saturation/contrast lift |
| Fast flicks and shake transitions | x264 veryslow with umh/merange=32/lookahead=60/aq-mode=3 tuning |
| Already-perfect files | lossless stream-copy remux — zero generation loss |
| "Did it actually work?" | VMAF + SSIM on every export, auto-retry below target |

## Tests

```
npm test          # unit + integration + end-to-end (needs the FFmpeg toolchain installed)
```

## Data

`%APPDATA%/valclips quality/` — settings.json (including the editable TikTok spec),
logs/app.log (every FFmpeg command and error), ffmpeg/ (bundled toolchain), previews/ (cache).
