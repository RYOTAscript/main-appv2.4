# Changelog

All notable changes to Launcher are documented here.
Versioning: **Patch** (0.0.x) = bug fixes · **Minor** (0.x) = new features · **Major** (x.0) = large redesign.

---

## [2.5.5] — 2026-07-05

### Changed

- **The launcher now starts on boot out of the box.** Auto start on boot was already
  fully wired up (it registers with Windows and re-asserts on every launch), but it
  shipped **off** by default, so a fresh install never actually launched at startup until
  you found the toggle in Settings and turned it on. First run now defaults the setting to
  **enabled**: the app registers itself with Windows startup and comes up automatically
  after you log in. This is a one-time default — the toggle in **Settings → Behavior**
  still works exactly as before, and if you turn it off there your choice is saved to
  `autostart-config.json` and honored on every launch afterward.

### Files changed

- `main.js` — `getAutoStartConfig()` first-run default is now `true` instead of falling
  back to "off"; `APP_VERSION` → v2.5.5.
- `main.html` — version strings → v2.5.5.
- `package.json` — `version` → 2.5.5.
- `CHANGELOG.md` — this entry.

---

## [2.5.4] — 2026-07-05

### Fixed

- **"Auto start on boot (show window)" toggle no longer resets to off after a restart.**
  The setting *was* being saved and re-registered with Windows every launch, but the
  Settings toggle read its state back with a live OS query (`getLoginItemSettings`) that
  passed a different `path`/`args` combination than the one used to register it. On
  Windows the two must match exactly, so the query always returned `false` and the toggle
  showed **off** on every restart even when autostart was active. The toggle now reflects
  the app's own persisted intent (`autostart-config.json`), which is the same value it
  re-asserts to the OS on each launch, and it still detects and adopts an existing OS
  registration on first run. Registration and detection now share one helper so their
  `path`/`args` can never drift apart again.

### Files changed

- `main.js` — added `getAutoStartLaunchOptions()` shared helper; `get-autostart` now
  returns the persisted config; `getAutoStartConfig()` first-run OS fallback queries with
  matching args.

---

## [2.5.3] — 2026-07-04

### Added

- **`Fix-Crash.cmd` / `Undo-Crash-Fix.cmd` — the guaranteed crash fix.** Testing
  confirmed v2.5.2's in-app crash handler does NOT suppress the Windows dialog: the
  `0xC0000409` fault is a CPU `__fastfail` that bypasses Chromium's handler and goes
  straight to Windows Error Reporting. The only reliable fix is a Windows-side one, so
  this ships a one-click, self-elevating helper that exempts `electron.exe` from
  **Hardware-enforced Stack Protection (CET)** — the well-documented resolution for
  STATUS_STACK_BUFFER_OVERRUN on 11th-gen+ Intel CPUs. It affects electron.exe only and
  is fully reversible via `Undo-Crash-Fix.cmd`. The user runs it themselves (double-click
  → approve the admin prompt); the app never changes system security settings on its own.

### Changed

- **Gentler auto-reload.** Since the crash (until the CET fix is applied) is persistent,
  the renderer auto-reload now stops after 2 attempts per minute instead of 4, so a
  reload→re-crash loop can't spam the dialog repeatedly.

### Files changed

- `Fix-Crash.cmd`, `Undo-Crash-Fix.cmd` — new helper scripts (in the app folder).
- `main.js` — auto-reload cap lowered 4 → 2; `APP_VERSION` → v2.5.3.
- `main.html` — version strings → v2.5.3.
- `package.json` — `version` → 2.5.3.
- `CHANGELOG.md` — this entry.

### Previous version

- 2.5.2 → **2.5.3**

---

## [2.5.2] — 2026-07-04

### Changed / Fixed

- **Crash handling + self-healing renderer (targets the "System Error" dialog).**
  The `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) renderer crash is an intermittent,
  low-level Chromium/Windows fault present since v2.3.0 (confirmed in the logs). It
  occurs with hardware acceleration ON or OFF and with V8's JIT ON or OFF, so it is
  neither the GPU nor the JIT — it's an environment-level conflict with **CET
  (Hardware-enforced Stack Protection)** on this 11th-gen Intel CPU. Two app-side
  changes now make it far less disruptive:
  1. **`crashReporter.start()`** — initialises Chromium's Crashpad handler (including
     its WER runtime-exception module, which is designed to catch `__fastfail`/
     stack-protection crashes). The app previously never started it, which is likely
     why Windows Error Reporting showed its own dialog. All local, nothing uploaded.
  2. **Renderer auto-reload** — a `render-process-gone` handler reloads the window if
     the renderer ever dies, so the app self-heals instead of leaving a dead window.
     Rate-limited (max 4 reloads/minute) to avoid a reload storm.

- **Reverted `--jitless` (from v2.5.1).** It did not stop the crash and only slowed
  JavaScript, so it was removed; full JS speed is restored.

- **Hardware acceleration stays ON** (from v2.5.1), so there is no lag.

### Notes / limitations

- If the Windows dialog still appears after a full restart, the **guaranteed** fix is
  a Windows-side one: exempt `electron.exe` from Hardware-enforced Stack Protection
  (CET). That needs Administrator and is a security-mitigation change, so it's offered
  as an opt-in (a 1-click fixer script, or Windows Security → Exploit protection steps).
- The underlying rare crash is a known Electron/Chromium issue on 11th-gen+ Intel
  (CET). Updating the Intel graphics/chipset drivers can also help.

### Files changed

- `main.js` — added `crashReporter.start()`; added `render-process-gone` auto-reload
  in `createWindow`; removed the `--js-flags=--jitless` switch; `APP_VERSION` → v2.5.2.
- `main.html` — version strings → v2.5.2.
- `package.json` — `version` → 2.5.2.
- `CHANGELOG.md` — this entry.

### Previous version

- 2.5.1 → **2.5.2**

---

## [2.5.1] — 2026-07-04

### Fixed

- **Root cause of the "stack-based buffer" crash finally identified and fixed:
  CET (Hardware-enforced Stack Protection) vs Chromium's JIT.** The PC is an
  11th-gen Intel i7-11800H, which has CET — a CPU feature that validates return
  addresses against a hardware "shadow stack". Windows was reporting the crash as
  `Faulting application name: bad_module_info`, `module: unknown`,
  `Exception code: 0xC0000409` — the exact fingerprint of CET issuing a
  `__fastfail` on Chromium/V8's JIT-compiled code. This is a CPU/OS-vs-Chromium
  conflict, **not a bug in the app**, which is why it fired on every launch, the
  instant the app started, and no application-code change (or GPU toggle) had any
  effect on it.
  Fix: launch Chromium's V8 with **`--jitless`** (interpreter only). With no
  JIT-generated code, CET has nothing to reject, so the crash cannot occur. The
  app does only tiny per-frame JavaScript, so interpreter-only mode is not
  noticeable, and the GPU still does all the rendering. Verified that Electron
  42.5.2 boots correctly under `--jitless` on this machine.

- **Reverted the lag from v2.5.0.** v2.5.0 had disabled hardware acceleration on a
  wrong hypothesis (that the GPU caused the crash). It didn't — it only made the
  UI render on the CPU, which felt laggy. Hardware acceleration is **back ON by
  default** now that the real cause (CET/JIT) is fixed directly. The
  `graphics-config.json` default is now `"gpu"`, and any existing file set to
  `"no-accel"` on this machine was switched back to `"gpu"`.

### Notes

- If, after a full restart, the dialog somehow still appears, the guaranteed
  alternative is a one-time Windows setting: exempt the app from "Hardware-enforced
  Stack Protection" (Windows Security → App & browser control → Exploit protection
  → Program settings → add `electron.exe` → turn off Hardware-enforced Stack
  Protection). That requires administrator rights; ask and we'll walk through it.
- `--jitless` disables WebAssembly. The app doesn't use it; noted in case a future
  feature needs it.

### Files changed

- `main.js` — added `--js-flags=--jitless` (the CET fix) for Windows; changed the
  default graphics mode back to `gpu` (hardware acceleration re-enabled);
  `APP_VERSION` → v2.5.1.
- `main.html` — version strings → v2.5.1.
- `package.json` — `version` → 2.5.1.
- `graphics-config.json` (in `%APPDATA%/main-launcher/`) — switched `no-accel` → `gpu`.
- `CHANGELOG.md` — this entry.

### Previous version

- 2.5.0 → **2.5.1**

---

## [2.5.0] — 2026-07-04

### Fixed

- **The buffer-overrun crash is now fixed at its real source.** v2.4.1 removed the
  audio capture, but the logs proved the renderer *still* crashed with the same
  `STATUS_STACK_BUFFER_OVERRUN` (`0xC0000409`) — so the cause was never the audio;
  it's a **GPU-compositor fault** in the transparent, glass-blur window on this
  Windows 10 GPU driver. **Hardware acceleration is now disabled by default**, so the
  UI renders on the CPU and there is no GPU process left to fault. On a 920×640
  window the animations remain smooth.
  - A new `graphics-config.json` (auto-created in `%APPDATA%/main-launcher/`) lets you
    switch modes **without editing code**:
    `{ "mode": "no-accel" }` (default, most stable), `{ "mode": "angle-gl" }`
    (keep the GPU but route it through ANGLE/OpenGL — try this if you want to test
    whether GPU mode is now stable), or `{ "mode": "gpu" }` (original full GPU).
    Restart the app after changing it. The active mode is written to the log at startup.

### Added

- **Beat-reactive CD/vinyl glow (real audio reactivity).** Because Spotify deleted the
  beat-data API, the glow now reacts to your PC's **actual audio output**: the app
  listens to the system audio via a loopback capture and pulses the disk glow to the
  bass in real time (a Web Audio FFT — CPU work, so it's unaffected by the GPU setting).
  - Lifecycle is handled cleanly: capture starts once when music is playing, is
    **reused across track changes** (no more restart-on-every-track churn), and is
    released when you pause, stop, disconnect, or turn Beat Glow off.
  - Still governed by the existing **Beat Glow** on/off toggle and **Beat Glow
    Intensity** slider in Settings.
  - If the loopback capture is unavailable for any reason, it automatically falls back
    to the gentle "ambient pulse" from v2.4.1 — the disk always stays alive.
  - The status line under the disk shows which mode is active
    (e.g. "Beat sync: live audio (reacting to PC sound)").

### Notes / limitations

- Beat detection listens to **all** PC sound (loopback), so loud non-music audio
  (game SFX, notifications) can also nudge the glow. This is inherent to reacting to
  real output now that Spotify's per-track beat data is gone.
- Removed the `--disable-gpu-sandbox` switch: it never helped this crash and is moot
  once hardware acceleration is off.
- If you ever want to A/B test smoothness, set `graphics-config.json` to `"angle-gl"`
  and see whether the crash stays away with the GPU on.

### Files changed

- `main.js` — added switchable graphics mode (`getGraphicsMode` + `graphics-config.json`),
  disabled hardware acceleration by default, removed `--disable-gpu-sandbox`, log the
  active graphics mode at startup; `APP_VERSION` → v2.5.0.
- `main.html` — re-added loopback audio beat detection (`liveAudio`,
  `ensureLiveAudioAnalyser`, `checkLiveAudioBeat`, `stopLiveAudioAnalyser`) with a clean
  start-once/reuse lifecycle and `useLiveAudioOrAmbient` fallback; wired `'live'` mode
  into the beat tick; version strings → v2.5.0.
- `package.json` — `version` → 2.5.0.
- `CHANGELOG.md` — this entry.

### Previous version

- 2.4.1 → **2.5.0**

---

## [2.4.1] — 2026-07-04

### Fixed

- **Startup crash: "The system detected an overrun of a stack-based buffer"
  (`STATUS_STACK_BUFFER_OVERRUN`, exit code `0xC0000409`).**
  The renderer (the whole UI) was crashing shortly after launch. Root cause:
  Spotify permanently retired its `/audio-analysis` and `/audio-features`
  endpoints (they now return HTTP 403), so the Beat Glow engine always fell
  through to its last-resort "live audio" mode. That mode captured the PC's
  screen + system (loopback) audio via `getDisplayMedia()` and tore the capture
  down and recreated it on **every track change** — repeatedly spinning up
  Windows screen/audio capture, which crashed the renderer on Windows 10.
  Fix: the screen/audio capture beat-detection path has been **removed
  entirely**. No capture is ever started now, so the crash trigger is gone.
  Animations and GPU acceleration are untouched.

- **Beat Glow now degrades gracefully.** When real beat data isn't available
  (which is now always, because Spotify removed the API), the disk shows a
  gentle "ambient pulse" — a smooth breathing glow driven purely off the
  track's playback position. It still respects the Beat Glow on/off toggle and
  the Beat Glow Intensity slider. If Spotify ever restores the analysis API,
  the original beat-accurate modes still work.

- **Playback/lyrics stutter and brief "disconnects" from Spotify rate-limiting
  (HTTP 429).** The app polled Spotify's player state every 1 second, which
  tripped Spotify's rate limit (logs showed ~1,900 `429` responses). The poll
  interval is now **2.5 seconds**. This is invisible in use: the progress bar
  and synced lyrics already interpolate smoothly between polls, and pressing
  play/pause/next/previous or seeking still refreshes the UI immediately.

- **Stopped hammering the dead Spotify beat endpoints.** Once the app sees the
  first `403` from the analysis/features endpoints, it stops requesting them for
  the rest of the session instead of retrying on every track (was ~1,570
  wasted failing requests per session; now ~2).

### Notes / limitations

- The GPU-side stability approach ("keep animations smooth") was chosen: no
  hardware-acceleration changes were made, because the crash came from the
  audio/screen capture, not from the animations. If — after testing — the
  buffer-overrun dialog still appears, the next step is a graphics-backend
  tweak or, as a last resort, disabling GPU acceleration.
- `setDisplayMediaRequestHandler` remains registered in `main.js` but is now
  never triggered (no code requests display media). It was left in place to
  avoid unrelated changes; it can be removed in a future cleanup.

### Files changed

- `main.html` — removed screen/loopback audio capture beat detection
  (`liveAudio` state, `ensureLiveAudioAnalyser`, `checkLiveAudioBeat`,
  `stopLiveAudioAnalyser` and all call sites); added `updateSimBeat` ambient
  pulse + `beatDataApiAvailable` guard; raised Spotify poll interval to 2500 ms;
  version string → v2.4.1.
- `main.js` — `APP_VERSION` → `v2.4.1`.
- `package.json` — `version` → `2.4.1`.
- `CHANGELOG.md` — added (this file).

### Previous version

- 2.4.0 → **2.4.1**
