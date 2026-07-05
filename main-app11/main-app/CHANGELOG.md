# Changelog

All notable changes to Launcher are documented here.
Versioning: **Patch** (0.0.x) = bug fixes · **Minor** (0.x) = new features · **Major** (x.0) = large redesign.

---

## [2.8.0] — 2026-07-05

### Added

- **Spotify Extras settings section, starting with a Sleep Timer.** A new
  "Spotify Extras" block in Settings (below Spotify Integration) is home to
  small Spotify quality-of-life features going forward. The first one is a
  Sleep Timer: pick 10/15/30/45/60/90 minutes and hit Start — Spotify
  playback pauses automatically when the timer runs out, with a live
  countdown and a Cancel button while it's running. The timer keeps running
  in the background even if Settings is closed, and survives a renderer
  auto-reload.

### Files changed

- `main.js` — added sleep timer state (`startSleepTimer()`,
  `cancelSleepTimer()`, `getSleepTimerStatus()`) and the
  `spotify-sleep-timer-start`/`-cancel`/`-status` IPC handlers; pushes
  `spotify-sleep-timer-ended` to the renderer when the timer elapses.
- `preload.js` — added `startSpotifySleepTimer`, `cancelSpotifySleepTimer`,
  `getSpotifySleepTimerStatus`, `onSpotifySleepTimerEnded` passthroughs.
- `main.html` — added the "Spotify Extras" settings section and its
  countdown/start/cancel UI logic; wired into `openSettings()` and
  `window.onload`.

---

## [2.7.3] — 2026-07-05

### Added

- **Mic auto-unmutes and the overlay shuts down when the app quits.** If the
  mic was muted via the Mic Mute widget, closing the app (window close, tray
  Quit, or Alt+F4) now unmutes it and destroys the overlay window as part of
  shutdown — so the app never exits leaving your microphone muted with no
  way to see or undo it.

### Fixed

- **Closing the main window no longer leaves the app running in the
  background.** The mic-mute overlay is a second, always-alive
  `BrowserWindow`, which meant Electron's `window-all-closed` event never
  fired from closing just the main window (it only fires once *every*
  window, including the hidden overlay, is gone) — so the process, tray
  icon, and mic mute state all silently lingered after the window closed.
  The main window now explicitly quits the whole app when it's closed.

### Files changed

- `main.js` — added a `before-quit` handler that unmutes the mic (if muted)
  and destroys the mic-mute overlay window before the app is allowed to
  finish quitting; the main window's `closed` event now explicitly calls
  `app.quit()` instead of relying on `window-all-closed`.

---

## [2.7.2] — 2026-07-05

### Changed

- **Mic Mute overlay now only appears while the mic is actually muted.**
  Previously the overlay badge was shown (as "MIC LIVE" or "MIC MUTED")
  the entire time the widget was enabled in Settings. It now stays hidden
  until you mute, then appears with "MIC MUTED", and disappears again the
  moment you unmute — nothing is drawn on screen while the mic is live.

### Fixed

- **Crash on relaunch while the app was quitting.** If a new launch was
  started in the brief window while a previous instance was still shutting
  down (e.g. closing the window and immediately reopening the app), the
  dying instance's single-instance handler tried to focus its own main
  window after it had already been destroyed, throwing an uncaught
  `Object has been destroyed` exception. `focusMainWindow()` now checks
  `isDestroyed()` before touching the window.

### Files changed

- `main.js` — `updateMicMuteOverlayState()` now shows/hides the overlay
  window based on mute state instead of always keeping it visible while
  enabled; `setMicMuteOverlayEnabled()` no longer force-shows the window
  on enable. `focusMainWindow()` now guards against an already-destroyed
  `mainWindow` before calling its methods.

---

## [2.7.1] — 2026-07-05

### Changed

- **Mic Mute indicator moved from an in-window badge to a system-wide overlay.**
  The status badge no longer lives next to the logo inside the app window — it's
  now drawn by a separate, transparent, click-through overlay window sized to the
  whole primary display, always on top of every other window (games, browsers,
  etc.), so it's visible whether or not the app itself is focused, minimized to
  tray, or behind other windows. The badge still switches between "MIC LIVE" and
  "MIC MUTED" instantly on every toggle (hotkey or tray), and only appears while
  the widget is enabled in Settings.

### Files changed

- `main.js` — added `createMicMuteOverlayWindow()`, `updateMicMuteOverlayState()`,
  `setMicMuteOverlayEnabled()`, and the `set-mic-mute-overlay-enabled` IPC
  handler; `toggleMicMute()` now updates the overlay instead of pushing to the
  main window.
- `mic-mute-overlay.html` (new) — the overlay window's badge markup/styling.
- `mic-mute-overlay-preload.js` (new) — minimal `contextBridge` API for the
  overlay window.
- `preload.js` — replaced `onMicMuteChanged`/`removeMicMuteChangedListener` with
  `setMicMuteOverlayEnabled`.
- `main.html` — removed the in-window badge and its CSS/JS; `applyMiniWidgetPrefs()`
  now enables/disables the overlay instead.
- `package.json` — version bumped to `2.7.1`; added the two new files to the
  packaged build.

---

## [2.7.0] — 2026-07-05

### Added

- **Mini Widgets framework + Mic Mute (first widget).** A new extensible system for
  small utility features, each with its own enable toggle and global hotkey,
  configured from a new **Settings → Mini Widgets** section. Future widgets
  (Bluetooth quick-connect, a macro tool, etc.) can be added as their own complete
  features without restructuring this scaffolding.
- **Mic Mute widget**: mutes/unmutes the system default microphone via a global
  hotkey (default `Ctrl+Shift+M`, rebindable in Settings), a tray checkbox item
  ("Mute Microphone"), or a click on the new always-visible badge in the top-left
  corner of the window (next to the logo). The badge only appears once the widget
  is enabled in Settings, and switches between a neutral "LIVE" state and a red
  "MUTED" state — it updates instantly no matter which of the three triggers
  (hotkey, tray, badge click) caused the change. Implemented with a pure Core
  Audio COM-interop PowerShell script (no external binaries).

### Files changed

- `main.js` — added the mic-mute PowerShell script generator, mute
  toggle/status/hotkey IPC handlers, tray checkbox item, and a startup state
  query.
- `preload.js` — added `micMuteToggle`, `getMicMuteStatus`,
  `registerMicMuteHotkey`, `onMicMuteChanged` passthroughs.
- `main.html` — added the `MINI_WIDGETS` registry, the Mini Widgets Settings
  section (enable toggle + hotkey bind, rendered generically from the registry),
  the top-left mic-mute badge, and export/import parity for `miniWidgetPrefs`.
- `package.json` — version bumped to `2.7.0`.

---

## [2.6.3] — 2026-07-05

### Security

- **Spotify client ID and OAuth tokens were stored as plaintext JSON on disk.**
  `spotify-config.json` and `spotify-tokens.json` (in `%APPDATA%/main-launcher/`)
  held the client ID and both the access and refresh tokens in the clear —
  readable by anything with filesystem access to the machine. Both files are
  now encrypted with Electron's `safeStorage` API, which defers to the OS
  keychain (DPAPI on Windows) so the contents are only decryptable by this
  app on this machine. Existing plaintext files from older versions are
  read once, then transparently re-saved encrypted — no user action needed,
  no re-login required. If OS-level encryption isn't available (e.g. no
  keychain present), the app falls back to plaintext rather than losing the
  saved login, and logs a warning.

### Files changed

- `main.js` — added `encryptedWriteJSON()`/`encryptedReadJSON()` helpers built
  on `safeStorage`; `loadSpotifyConfig()`, `saveSpotifyConfig()`,
  `loadSpotifyTokens()`, `saveSpotifyTokens()` now route through them, with
  automatic migration of legacy plaintext files.
- `main.html` — version bumped to match.
- `package.json` — version bumped to `2.6.3`.

---

## [2.6.2] — 2026-07-05

### Fixed

- **Displayed version number was stuck on "v2.5.3".** The 2.6.0/2.6.1 releases (Settings
  search) updated `package.json` and this changelog but missed `main.js`'s `APP_VERSION`
  constant and the two version strings shown in `main.html` (Settings footer + app
  footer), so the app kept showing an old version number after two real releases. All
  four now stay in sync with `package.json`.
- **Spotify requests could hang the app if a refreshed token still got a 401.**
  `spotifyApiRequest()` retried on 401 by refreshing the token and calling itself again
  with the *same* retry count — if the new token also came back 401 (e.g. a scope
  mismatch refreshing can't fix), it would recurse forever instead of failing. Retries
  after a 401 are now capped at one.
- **A corrupted Settings entry could blank the entire app.** `pinnedApps`, `hotkeys`, and
  `widgetPrefs` were read from `localStorage` with a bare `JSON.parse()` and no
  try/catch. Since these run at the top of the main `<script>` block, a single malformed
  value (e.g. from a crash mid-write) would throw during initial page load and abort
  the whole script — leaving every button and widget non-functional with no error shown.
  All `localStorage` JSON reads now go through a `safeParseJSON()` helper that falls
  back to the default value instead of throwing.

### Files changed

- `main.js` — `APP_VERSION` bumped to match `package.json`; capped 401-retry recursion
  in `spotifyApiRequest()`.
- `main.html` — `APP_VERSION` and the two version display strings bumped; added
  `safeParseJSON()` and used it for the `pinnedApps`/`hotkeys`/`widgetPrefs` reads.
- `package.json` — version bumped to `2.6.2`.

---

## [2.6.1] — 2026-07-05

### Changed

- **Cleaner pinned Settings search bar.** While scrolling, the bar now covers the panel's
  top padding (no content peeking above it) and uses a solid blurred backdrop with a soft
  hairline divider instead of a translucent strip.
- **Type-to-search.** With Settings open, just start typing — the first character focuses
  the search box and begins filtering, no click required.
- The **"Search settings…"** placeholder text is now white.

### Files changed

- `main.html` — `.settings-search-bar` sticky CSS + white placeholder; type-to-search added
  to the global keydown handler.

---

## [2.6.0] — 2026-07-05

### Added

- **Search bar at the top of Settings.** Type to instantly filter the settings list to
  matching sections (e.g. "spotify", "clock", "glow"); clears automatically each time
  Settings is opened. A "No settings match your search." message shows when nothing matches.

### Files changed

- `main.html` — sticky search input + `filterSettings()` filter; reset on `openSettings()`.

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
