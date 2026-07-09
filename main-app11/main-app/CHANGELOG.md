# Changelog

All notable changes to Launcher are documented here.
Versioning: **Patch** (0.0.x) = bug fixes · **Minor** (0.x) = new features · **Major** (x.0) = large redesign.

---

## [3.19.0] — 2026-07-09

### Added

- **Vegas-style multi-track timeline:** below the trim bar the Video Editor now
  shows stacked track lanes — a **video lane** with a thumbnail filmstrip on top,
  and **one lane per audio track** with its own waveform (labelled A1 · ENG,
  A2 · FRE, …). All lanes share the trim bar's exact time axis, so the trim
  selection dims the lanes outside the cut and a single playhead line runs
  through every lane. Clicking anywhere on the lanes seeks. The filmstrip and
  waveforms are rendered by the bundled FFmpeg and cached (cleaned up on quit),
  with a loading shimmer while they generate.

### Files changed

- `main/videoEditor.js` — `video-timeline-assets` handler that renders a video
  filmstrip (tiled thumbnails) and a per-track waveform (showwavespic), cached
  alongside the preview proxies.
- `preload.js` — `videoTimelineAssets` passthrough.
- `renderer/video-editor.js` — track-lane rendering, asset loading/painting, and
  selection/playhead overlays synced across all lanes.
- `styles/main.css` — track-lane, waveform, filmstrip and overlay styles.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.19.0.

## [3.18.0] — 2026-07-09

### Added

- **Video Editor keyboard controls:** with the preview on screen, **Space**
  plays/pauses and the **← / →** arrow keys step one frame at a time (a hint
  under the controls spells this out). Keys are ignored while typing in a field.
- **Player settings (gear icon):** a new gear button on the imported clip opens
  a small settings area with:
  - **Preview quality** — *Original / 1080p / 720p / 360p*. Choosing a lower
    quality builds a fast, cached low-res **proxy** with the bundled FFmpeg so
    heavy/4K clips scrub and play back smoothly, with a progress bar and Cancel.
    Qualities at or above the source resolution are disabled, and **exports
    always use the original full-quality source** — the proxy is preview-only.
  - **Audio track detection & selection** — when a file carries more than one
    audio track they're detected and listed (language / title / channels /
    codec), and you can **choose which track is kept** in the exported trim.

### Files changed

- `main/videoEditor.js` — audio-stream enumeration in the probe; low-res preview
  proxy build/cancel (cached in temp, cleaned on quit); audio-track mapping on
  export.
- `preload.js` — `videoMakeProxy` / `videoCancelProxy` / `onVideoProxyProgress`.
- `renderer/video-editor.js` — gear settings panel (preview quality + audio
  track), proxy handling with position-preserving source swap, and the
  Space/←/→ keyboard controls.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.18.0.

## [3.17.0] — 2026-07-09

### Added

- **Draggable Spotify Enhanced panel:** a new **Draggable panel** toggle in the
  Spotify Enhanced settings shows a small grip at the top of the player strip.
  Grab it to drag the strip anywhere within the player; its position is saved and
  restored automatically. Position is remembered **separately** for the two
  layouts (compact, when Spotify shares the player, and the full-width solo
  layout), so each looks right. A **Reset** button restores the default position.
  The setting and saved positions are included in settings export/import.

### Files changed

- `main.html` — grip handle markup at the top of the inline strip.
- `styles/main.css` — grip styling; visible only in draggable mode.
- `renderer/spotify-enhanced.js` — draggable state, drag handlers (with
  per-layout persistence and in-bounds clamping), and the settings toggle.
- `renderer/widgets-settings.js` — re-apply saved position on layout change;
  export/import of `spotifyEwDraggable` / `spotifyEwPos`.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.17.0.

## [3.16.1] — 2026-07-08

### Changed

- **Spotify Enhanced strip polish:** the Queue tab now shows only the upcoming
  queue (the "Now" row was dropped, since the current track is already on the
  player), playlist rows now show each playlist's **cover art**, and the strip
  sits a little higher in both the compact and expanded layouts.

### Files changed

- `renderer/spotify-enhanced.js` — Queue tab drops the now-playing row;
  playlist rows render cover art.
- `styles/main.css` — nudged the strip up (compact and `.spotify-solo`).
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.16.1.

## [3.16.0] — 2026-07-08

### Added

- **The Spotify Enhanced strip expands when Spotify is the only widget.** When
  you turn off Quick Notes and Performance so the Spotify player spans the full
  width, the Queue / Recent / Playlists strip grows into the open space to the
  right of the vinyl — larger tabs, bigger rows and album thumbnails — instead
  of staying the tiny corner panel. It automatically shrinks back to the compact
  version when another widget is shown again.

### Files changed

- `styles/main.css` — `.spotify-solo` overrides that enlarge and reposition the
  strip in the full-width layout.
- `renderer/widgets-settings.js` — add/remove the `spotify-solo` class on the
  player when Spotify is the only visible widget.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.16.0.

## [3.15.0] — 2026-07-08

### Added / Changed

- **Spotify Enhanced now lives on the player itself.** The Queue / Recent /
  Playlists panel is mirrored as a compact three-tab strip crammed into the
  upper-right of the Spotify player (over the vinyl area, translucent, clear of
  the playback controls and volume), so you can browse without opening
  Settings. The Settings panel is kept too.
- **Favourite playlists.** Star any playlist (in the strip or the Settings
  panel) to pin it to the top of the list, everywhere. Favourites are saved and
  included in Settings backup/restore.
- **Playlist sorting.** Playlists sort by **Recently opened** (default —
  tracked locally whenever you start one from here) or **A→Z**, with favourites
  always floated to the top. Toggle the sort from either the strip or the
  Settings panel.

### Files changed

- `renderer/spotify-enhanced.js` — favourites/sort/recently-opened helpers; the
  inline player-strip renderers (Queue/Recent/Playlists); playlist sorting +
  stars added to the Settings panel too; record "recently opened" on play.
- `main.html` — the inline strip markup inside the player; version bump.
- `styles/main.css` — strip + compact-row styling.
- `renderer/widgets-settings.js` — playlist favourites/sort in backup/restore.
- `renderer/core.js`, `package.json`, `main.js` — version → 3.15.0.

## [3.14.0] — 2026-07-08

### Added

- **New "Video Editor" mini widget — a fast, simple trimmer.** Enable it from
  Settings → Mini Widgets. It's built for speed and clarity rather than being a
  full editing suite:
  - **Import a video** (mp4, mkv, mov, avi, webm, and more) and preview it
    inline with a scrubbable timeline and playback controls.
  - **Frame-accurate trimming** — drag the in/out handles, or set them to the
    playhead, and step a single frame at a time for an exact cut.
  - **Keep or drop the audio track** with one toggle.
  - **Lossless export by default** — the trim stream-copies with no re-encode,
    so there's no quality loss and it's near-instant. A **Precise cut** toggle
    re-encodes at visually-lossless quality when you need an exact frame
    boundary a keyframe-aligned copy can't give.
  - Shows the **estimated output size**, an **export progress bar**, the
    **save location**, and an **Open folder** shortcut when it's done; exports
    can be cancelled mid-run.
  - **FFmpeg is bundled** with the app (via `ffmpeg-static`) — nothing to
    install.

### Files changed

- `package.json` — added the `ffmpeg-static` dependency and `asarUnpack` so the
  FFmpeg binary is packaged and runnable in built releases; version → 3.14.0.
- `main/videoEditor.js` (new) — FFmpeg path resolution (asar-aware), metadata
  probe, lossless/precise trim with live progress, and the
  `video-check` / `-pick-input` / `-pick-output` / `-export` / `-cancel` /
  `-reveal` IPC handlers.
- `main.js` — initialize the module; kill any in-flight export on quit.
- `preload.js` — video passthroughs + the export-progress event.
- `renderer/core.js` — registered the `videoEditor` mini widget; version bump.
- `renderer/video-editor.js` (new) — the editor UI: preview, timeline,
  in/out handles, options, and the export flow.
- `renderer/widgets-settings.js` — render hook.
- `main.html` — new script tag; version bump.
- `styles/main.css` — timeline / handle / playhead styling.

## [3.13.0] — 2026-07-08

### Added

- **New "Bluetooth Manager" mini widget.** Enable it from Settings → Mini
  Widgets to manage Bluetooth without leaving the launcher:
  - **See every paired device** with its real, live connection status and
    battery level (where the device reports it).
  - **Connect or disconnect** any device with one click, and **remove**
    (unpair) devices you no longer use.
  - **Scan for nearby devices** and **pair** new ones directly from the panel.
  - **Auto-refreshes** the device list every few seconds while the panel is
    open, so status and battery stay current.
  Built on the documented Win32 Bluetooth API (via a cached PowerShell/C#
  helper) — the accurate source of a device's true connection state, unlike
  the Device Manager "OK" status. Some actions (remove/pair on certain
  adapters) are best-effort and may require the device to be in range or need
  a confirmation on the device itself.

### Changed

- **`runCmd` now accepts an optional timeout** so long-running shell helpers
  (like a Bluetooth inquiry) can't hang the caller indefinitely. Existing
  callers are unaffected (default is still "wait indefinitely").
- **Mini-widget icons can specify a Font Awesome style** (`iconStyle`), so
  brand glyphs like the Bluetooth mark render correctly in Settings.

### Files changed

- `main/bluetooth.js` (new) — cached PowerShell + C# helper (BluetoothFind*,
  SetServiceState, RemoveDevice, AuthenticateDeviceEx) and the
  `bluetooth-list` / `-scan` / `-connect` / `-disconnect` / `-remove` /
  `-pair` IPC handlers; addresses are validated before use.
- `main/shellUtils.js` — optional timeout + larger output buffer for `runCmd`.
- `main.js` — initialize the module.
- `preload.js` — six Bluetooth passthroughs.
- `renderer/core.js` — registered the `bluetooth` mini widget (brand icon);
  version bump.
- `renderer/bluetooth.js` (new) — the panel UI and auto-refresh loop.
- `renderer/widgets-settings.js` — render/enable hooks; `iconStyle` support.
- `main.html` — new script tag; version bump.
- `package.json`, `main.js` — version → 3.13.0.

## [3.12.0] — 2026-07-08

### Added

- **New "Screen Resolution" mini widget.** Enable it from Settings → Mini
  Widgets to control every attached monitor's display mode:
  - **Detects all monitors** and every resolution + refresh rate each one
    supports, and shows the current mode.
  - **Switch instantly** — pick a resolution and refresh rate and hit Apply;
    the change takes effect immediately, per-monitor, with full multi-monitor
    support.
  - **15-second auto-revert safety net.** After a switch, a "Keep this display
    mode?" bar counts down from 15 seconds; if you don't confirm (e.g. the new
    mode blacks out the screen), the previous mode is restored automatically —
    the same protection Windows' own display settings use.
  - **Favourite the modes you use most** with a star; favourites appear as
    one-click chips per monitor and are included in Settings backup/restore.
  Uses the Win32 display API (EnumDisplaySettings / ChangeDisplaySettingsEx)
  via a small cached PowerShell helper — no external tools.

### Files changed

- `main/screenResolution.js` (new) — versioned PowerShell + C# helper to list
  monitors/modes and switch them (test-then-apply); `screen-resolution-list`
  and `screen-resolution-set` IPC handlers.
- `main.js` — initialize the new module.
- `preload.js` — `screenResolutionList` / `screenResolutionSet` passthroughs.
- `renderer/core.js` — registered the `screenResolution` mini widget; version
  bump.
- `renderer/screen-resolution.js` (new) — panel UI: per-monitor mode pickers,
  favourites, and the keep/auto-revert countdown.
- `renderer/widgets-settings.js` — render hooks + favourites in export/import.
- `main.html` — new script tag; version bump.
- `package.json`, `main.js` — version → 3.12.0.

## [3.11.0] — 2026-07-08

### Added

- **New "Spotify Enhanced" mini widget.** Enable it from Settings → Mini
  Widgets to extend the Spotify player with quality-of-life extras. Off by
  default — when disabled, none of it appears. When enabled it adds:
  - **Like / Unlike the current song** with a heart button right on the
    player's control row (it lights up Spotify-green when the track is in your
    Liked Songs), plus a mirrored control in the settings panel.
  - **Queue Viewer** — see what's playing now and what's up next.
  - **Recently Played** — browse your last 25 tracks; click any to replay it.
  - **Playlist Shortcuts** — all your playlists in one list; click to start
    playback on your active device.
  The panel uses a compact tabbed layout (Queue / Recent / Playlists) that
  matches the existing settings spacing and glass UI, with loading states and
  a refresh button.
- Because these features need extra Spotify permissions (recently-played,
  playlist read, and Liked-Songs read/write), anyone who connected Spotify
  before this update will see a one-click **Reconnect** prompt the first time
  they open the panel or tap the heart; new connections request them
  automatically.

### Fixed

- **Spotify API calls that return an empty `200` body** (like adding/removing
  a Liked Song) are no longer misread as failures — the response parser now
  treats an empty body as success instead of throwing on `JSON.parse`.

### Files changed

- `main/spotify.js` — expanded OAuth scopes; robust empty-body response
  handling; new `spotify-get-queue`, `spotify-recently-played`,
  `spotify-get-playlists`, `spotify-play-context`, `spotify-is-saved`, and
  `spotify-set-saved` IPC handlers.
- `preload.js` — added the six Spotify Enhanced passthroughs.
- `renderer/core.js` — registered the `spotifyEnhanced` mini widget;
  synced the stale `APP_VERSION` constant.
- `renderer/spotify-enhanced.js` (new) — the panel UI, heart-button logic,
  and playback helpers.
- `renderer/spotify-widget.js` — refresh the like-state on track change.
- `renderer/widgets-settings.js` — render/enable hooks for the new widget.
- `main.html` — heart button on the player; new script tag; version bump.
- `styles/main.css` — liked-heart styling + pop animation.
- `package.json`, `main.js` — version → 3.11.0.

## [3.10.0] — 2026-07-07

### Added

- **New "Clipboard History" mini widget.** Enable it from Settings → Mini
  Widgets to keep a running history of everything you copy (up to 50
  snippets). Click any entry to re-copy it, pin favorites to keep them from
  being evicted, delete individual entries, or clear the whole history.
  History persists across restarts. Snippets tagged as sensitive by
  password managers (1Password, Bitwarden, etc.) are never recorded.

## [3.9.0] — 2026-07-07

### Fixed

- **Closing Settings while binding a hotkey no longer leaves keyboard input
  stuck.** The capture listener is now torn down when the modal closes, so a
  cancelled bind can't swallow subsequent keystrokes.
- **Spotify media-key hotkeys no longer double-fire** a single press under
  certain focus/timing conditions.
- **FPS Optimizer's process whitelist** no longer both over- and
  under-protects processes: matching is now exact-name (case-insensitive,
  `.exe` stripped) instead of substring, so `cmd` no longer incorrectly
  matches `cmder.exe`. `powershell`/`pwsh` are protected, and the app's own
  process names are always excluded from termination.
- **FPS Optimizer no longer reports false success.** Optimize, Battery Saver,
  and the new Revert action now track each step's real success/failure and
  report accurately, instead of always claiming full success.
- **Added a "Restore Defaults" button** to the FPS panel that reverts the
  optimizer's registry/service changes back to Windows defaults.
- **Fixed a Spotify token-refresh race** where concurrent callers could each
  trigger their own refresh, rotating the refresh token out from under each
  other. Concurrent refresh calls now share a single in-flight request.
- **Fixed Spotify's OAuth login popup** being openable multiple times at once
  if clicked repeatedly.
- **Spotify progress-bar seeking** now only sends the seek request once, on
  mouse release, instead of on every drag movement (matching the existing
  volume-slider behavior).
- **Fixed a stale-retry bug** in Spotify polling where disconnecting and
  reconnecting within the backoff window could leave an old retry timer
  running against the new session.
- **Autostart state and Settings** no longer briefly disagree on load.
- **Custom launcher icons are now stored in the app's userData folder**
  instead of its install directory, fixing potential write-permission
  failures and update-wipe data loss; existing custom icons are migrated
  automatically and non-destructively.
- **Hotkey conflicts are now detected across categories** (e.g. a macro
  hotkey colliding with the mic-mute hotkey), not just within one.
- **Fixed visualizer blurriness** after a display's DPI/scale changed
  without an app restart, and a brief flicker in the widget grid layout.
- **Added a cancel affordance** while binding a hotkey, and removed leftover
  debug logging from the hotkey-bind flow.
- **Bounded the Spotify audio-analysis/features and lyrics caches** so they
  no longer grow without bound over long always-on sessions.
- **Mic-mute overlay window load failures are now logged** instead of
  failing silently.
- **The weather widget's primary fetch now times out after 6s** instead of
  potentially hanging for up to 20s before falling back.
- **The macros enable/disable hotkey can no longer be set to a mouse
  button** — Electron's global shortcut mechanism (which the toggle hotkey
  uses) doesn't support mouse buttons, so this is now rejected server-side,
  not just in the picker UI.
- **Fixed macro recording incorrectly stripping unrelated keypresses** that
  shared a base key with a modified toggle hotkey (e.g. recording `F9` alone
  would previously also get stripped if the toggle hotkey was `Ctrl+F9`).

## [3.8.1] — 2026-07-06

### Fixed

- **Turning off the Macros mini-widget now collapses its whole section** in
  Settings, instead of leaving the description and full macro list visible
  with just a "Widget disabled" note. Toggling it back on brings the section
  back exactly as it was.

## [3.8.0] — 2026-07-06

### Added

- **Duplicate a single step.** Each step in the step editor now has a copy
  button (next to move up/down and remove) that inserts an identical copy right
  after it, ready to tweak. This is separate from the macro-level "duplicate"
  button, which copies the whole macro.

### Changed

- **Macro trigger keys now pass through to other apps.** Previously a keyboard
  trigger in Key Pressed / Key Toggle mode was captured by a Windows global
  shortcut, which *swallowed* the key so it never reached the focused game or
  app. All macro triggers (every mode, keyboard and mouse) are now handled by
  the macro engine's passive key watcher instead, so the trigger key still
  registers normally in whatever app is focused — the same behaviour Hold /
  Released and mouse triggers already had, and how TG Macro works.
  - Practical effect: a macro bound to a plain key (e.g. `G`) will fire on
    *every* press of that key, including while you type — so prefer function
    keys, side mouse buttons, or modifier combos for triggers you don't want to
    fire accidentally.
  - The enable/disable toggle hotkey (F9 by default) is unchanged: it stays a
    global shortcut and is still swallowed, since it's a dedicated control key.

## [3.7.0] — 2026-07-06

### Changed

- **The "stop everything" hotkey is now an enable/disable-macros toggle.**
  Instead of only stopping whatever is running, the hotkey (still **F9** by
  default) now flips all macros on or off. When disabled, every macro trigger —
  keyboard, mouse, hold/release — stops responding, and anything currently
  playing is halted immediately; press the hotkey again to re-enable. This is a
  superset of the old behaviour (disabling still stops a running macro) with a
  clearer mental model.
- **New "Macros enabled / Macros disabled" button in the panel.** Sits next to
  the toggle-key binder and shows the current state (green check when enabled,
  grey when disabled); click it to flip without touching the keyboard. The
  enable/disable state persists across restarts.
- The macro engine is kept warm while disabled, so re-enabling is instant.
- This is separate from the Settings widget master switch: the master switch
  turns the whole widget off (and releases the toggle hotkey), while the new
  button/hotkey enables or disables the macros within an enabled widget.

### Migration

- Existing `stopHotkey` settings are read as the new toggle hotkey automatically
  — no reconfiguration needed. Macros start enabled by default.

## [3.6.1] — 2026-07-06

### Changed

- **Left click can now be bound as a macro trigger too.** All five mouse buttons
  (left, right, middle, Mouse 4, Mouse 5) are now assignable. Note that a macro
  bound to left click fires on every left click while the widget is enabled —
  including clicks inside the app — so use it deliberately.
- Simplified the bind prompt to "Press a key or mouse button — Esc to clear".

## [3.6.0] — 2026-07-06

### Added

- **Mouse buttons can trigger macros.** When binding a macro's trigger, you can
  now press a mouse button instead of a key: right click, middle click, or a
  side button (Mouse 4 / Mouse 5). All four trigger modes work — Key Pressed,
  Key Hold, Key Toggle, and Key Released behave the same as with keyboard keys.
  Because Windows global shortcuts are keyboard-only, mouse triggers are handled
  by the macro engine's key watcher, so they also still reach the focused game
  or app. Left click is intentionally not bindable (it's needed to operate the
  app), and the stop-everything hotkey remains keyboard-only. Side buttons
  (Mouse 4 / 5) are the safest choice, since the engine never synthesizes them
  during playback.

## [3.5.2] — 2026-07-06

### Fixed

- **Pressing Esc to clear a macro hotkey no longer also closes Settings.** The
  key capture now fully consumes the event (`stopImmediatePropagation`) so it
  can't fall through to the Settings close/media/search handlers, which share
  the same capture-phase keydown listener. This also stops any key you bind
  (e.g. a Spotify media key) from firing its normal action at the moment you
  assign it.

## [3.5.1] — 2026-07-06

### Fixed

- **Binding a macro hotkey no longer types into the Settings search box.** While
  assigning a macro's trigger hotkey (or capturing a key for a step), the
  keystroke was also landing in the settings search field, filtering the page
  out from under you. Both scripts listen on the same capture-phase keydown, so
  the search handler now stands down whenever a macro key capture is in
  progress, the same way it already does during recording.

### Changed

- **Press Esc while binding a macro hotkey to clear it.** Escape now unbinds the
  macro's trigger and shows a dash (—) indicator instead of cancelling with the
  old hotkey intact. Unbound macros display the dash too, matching the rest of
  the app's hotkey rows. (The stop-everything hotkey can't be blank, so Escape
  there still just cancels.)

## [3.5.0] — 2026-07-06

### Added

- **"Record" filter dropdown next to Record new.** A caret button beside
  Record new opens a menu to choose exactly what a fresh recording captures:
  mouse movement, mouse buttons, keyboard keys, and delays (waits). Turn off
  mouse movement to record a pure key sequence, turn off delays to capture the
  actions with no waiting between them, and so on. Your choices are remembered
  across sessions and apply to both Record new and Re-record.
- **Clear all steps.** An eraser button in the macro editor (next to Duplicate)
  empties a macro's steps in one click, so you can rebuild it from scratch
  without deleting and recreating the whole macro.

## [3.4.0] — 2026-07-06

### Added

- **Trigger modes for macros — like TG Macro's "When:" dropdown.** Each macro's
  hotkey can now fire one of four ways: **Key Pressed** (plays when pressed),
  **Key Hold** (plays/loops only while the key is physically held — releasing it
  stops), **Key Toggle** (press to start, press again to stop), and
  **Key Released** (plays when the key is released). Hold and Released work
  through a new passive key watcher in the macro engine, since regular global
  shortcuts can't see key releases; those trigger keys also still reach the
  focused app instead of being swallowed. Existing macros migrate automatically
  (loop on → Key Toggle, loop off → Key Pressed).
- **Repeat count and playback speed per macro.** Set how many times a macro runs
  per trigger (1–9999, or "until stopped") and play it back anywhere from 0.25×
  to 4× the recorded speed. The editor also shows the estimated duration per run.
- **New step types in the macro editor:** scroll the mouse wheel (up/down, any
  number of notches), type free text (full Unicode, layout-independent), and
  move the mouse to a fixed position without clicking.
- **Alt + X position capture.** Giving a click or move step a fixed screen
  position no longer uses a 3-second countdown — click the crosshair, hover the
  target anywhere on screen, and press **Alt + X** to capture the exact spot.
- **Per-macro enable checkbox, duplicate button, and import/export.** Disable a
  single macro without deleting it, clone one as a starting point, and save or
  load your whole macro collection as a JSON file.

### Fixed

- **Re-record and recording UX.** While a macro recording is running, the
  Settings type-to-search no longer steals your keystrokes into the search box
  (which could filter the macros panel out of view mid-recording and made
  re-recording appear broken). The macro engine also warms up as soon as the
  widget is enabled, so the first record/play starts instantly instead of
  sitting through a several-second one-time compile with no feedback, and the
  Record buttons now show a "Starting recorder…" toast immediately.

## [3.3.0] — 2026-07-05

### Added

- **Macros mini widget.** Record and replay mouse & keyboard actions system-wide,
  in the style of TG Macro. Record your real input (clicks, key presses, mouse
  movement, timing) or build a macro step by step in the editor (key press,
  hold/release key, clicks with optional fixed screen positions, delays).
  Each macro gets its own global hotkey that works in games, plus a loop toggle
  to repeat until stopped. F9 (configurable) instantly stops any recording or
  running macro; it is only held while something is actually running, so F9
  stays free for games the rest of the time. Keyboard playback sends hardware
  scan codes so it works in games that use DirectInput. Enable it from
  Settings → Mini Widgets. No extra software needed — recording and playback
  run through a small helper process built on Windows APIs.

## [3.2.0] — 2026-07-05

### Added

- **Display Monitor setting.** Choose which physical monitor the main window
  opens on from Settings → Behavior. The window repositions immediately when
  changed, and the choice is remembered for the next launch. If the previously
  selected monitor is no longer connected, the app falls back to the primary
  display instead of failing to open.

## [3.1.0] — 2026-07-05

### Added

- **GPU-accelerated audio visualizer behind the vinyl disk.** A new WebGL-rendered
  visual reacts live to your PC's audio output and renders behind the spinning
  vinyl disk on the Spotify widget. Four modes: circular bars, a waveform ring
  that circles the disk, a white Aura mode (a soft glowing halo that flows and
  breathes organically around the disk, driven independently by bass, mid, and
  treble energy), and particles. Off by default — enable it (and pick a mode)
  from Settings → Spotify Extras. It uses its own independent loopback audio
  capture, kept separate from the existing Beat Glow capture so the two
  features can be toggled independently without affecting each other, and it
  only captures/renders while a track is actively playing.
- **Spotify Extras is now collapsible**, and now holds every Spotify
  quality-of-life setting in one place: Sleep Timer, Auto-play on Spotify
  launch, Vinyl Disk Rotation Speed, Beat-reactive glow, Lyrics Timing, and
  the new Audio Visualizer. These were previously split across "Spotify
  Integration" and "Spotify Extras"; "Spotify Integration" now only holds
  connection setup (Client ID, Connect/Disconnect) and the progress timer
  display mode. The collapsed/expanded state is remembered between sessions.

## [3.0.1] — 2026-07-05

### Fixed

- **Disconnecting Spotify no longer crashes the widget.** Clicking Disconnect
  in Settings threw an error inside the widget renderer (it was handed `null`
  instead of a "not connected" state), so the widget kept showing the last
  track instead of switching to the "Not connected" view. It now switches
  correctly.
- **An unbound hotkey no longer acts as a real "-" key binding.** When
  binding a hotkey displaces another one, the displaced slot is stored as
  "-" (unbound). That sentinel was previously treated as a real binding: it
  matched the minus key inside the app and was even registered as a
  system-wide global shortcut, hijacking the bare "-" key across Windows.
  It is now ignored everywhere (in-app matching, Spotify shortcuts, mic-mute
  hotkey, and the focus hotkey).
- **Quitting can no longer hang if mic-unmute cleanup fails.** The
  quit-time "unmute mic and tear down overlay" step had no error guard — if
  it threw, the app could never finish quitting. It now always releases the
  quit even when cleanup fails.
- **The app's own process is now correctly protected during FPS-optimizer
  process kills.** The main app's renderer PID was captured before the
  renderer process existed (always 0), so the PID-based protection in
  "Close apps" / "Nuke" / "Battery Saver" never actually covered the app
  itself (only the name-based whitelist did). The PID is now captured when
  the page finishes loading and re-captured after a crash auto-reload.
- **FPS optimizer progress listeners no longer pile up.** Every action run
  added a new progress listener without removing the previous one, leaking
  listeners across runs within the same session. Also, if the action was
  triggered while the bridge was unavailable, the "action in progress" flag
  stayed stuck and blocked all further actions.
- **Spotify control/volume/seek no longer report success on API errors**
  (error responses were truthy objects and read as success).
- **Playing a podcast episode can no longer crash the track poll** — episode
  items have no artists/album, and those fields are now read defensively
  (falling back to the show name/publisher).
- **Toasts appearing in quick succession get their full display time** —
  previously the first toast's hide timer cut the second one short.
- **Spotify PKCE login now uses cryptographically secure randomness** for
  the code verifier (was `Math.random()`, which RFC 7636 forbids).
- Small leaks/cleanups: settings-export blob URL is now released after the
  download; drag-reorder state resets after each drop; a lyrics log call
  passed its metadata in the wrong argument slot.

### Files changed

- `main.js` — renderer PID captured on `did-finish-load` (and re-captured on
  auto-reload); `before-quit` cleanup wrapped in try/finally; focus-hotkey
  handler rejects the "-" sentinel.
- `main/spotify.js` — skip "-" when registering Spotify global shortcuts;
  `success` flags exclude `_error` results; episode-safe track fields;
  crypto-secure PKCE verifier.
- `main/micMute.js` — "-" treated as "clear hotkey" instead of a binding.
- `main/lyrics.js` — log metadata fixed.
- `renderer/spotify-widget.js` — disconnect renders the not-connected state
  instead of crashing.
- `renderer/hotkeys.js` — `keydownMatches` ignores unbound ("-"/empty)
  accelerators.
- `renderer/fps-optimizer.js` — progress listener replaced per run; stuck
  in-progress flag fixed.
- `renderer/ui-utils.js` — toast hide timer tracked per toast.
- `renderer/widgets-settings.js` — export URL revoked; drag state reset.

---

## [3.0.0] — 2026-07-05

### Changed

- **Large internal reorganization — no user-visible feature changes.** The two
  monolithic files that had grown over many feature passes (`main.js` at
  ~2000 lines, `main.html` at ~4700 lines) are now split into focused,
  single-purpose files so the codebase is easier to navigate and maintain.
  Every IPC channel, lifecycle handler, `onclick` handler, and
  `electronAPI.*` call was diffed line-for-line against the pre-refactor
  originals to confirm nothing was dropped or altered — this is purely a
  file-layout change.
- **Small cleanups made alongside the split:** removed a dead, unused
  `USER_APPS`/`WHITELIST_STD` constant pair from the FPS optimizer code;
  removed a redundant duplicate Spotify config/token load that ran twice at
  startup with no observable effect; replaced defensive `logger.debug?.(...)`
  optional-chaining calls with plain `logger.debug(...)` since the method is
  always present on `Logger`.

### Files changed

- `main.js` — rewritten as a slim orchestrator (~340 lines, down from
  ~2000). Owns app lifecycle, window/tray management, and delegates
  everything else to the new `main/` modules via a shared `ctx` object.
- `main/httpClient.js`, `main/shellUtils.js`, `main/scriptCache.js` — small
  shared helpers (fetch wrapper, PowerShell exec wrapper, versioned
  script-file cache) extracted out of what used to be inline code.
- `main/autostart.js`, `main/systemStats.js`, `main/appLauncher.js`,
  `main/fpsOptimizer.js` — extracted feature modules for Windows autostart,
  CPU/RAM/FPS polling, the pinned-apps launcher, and the FPS optimizer's
  system tweaks.
- `main/micMute.js` — mic-mute Core Audio COM script, overlay window, tray
  integration, and hotkey handling.
- `main/spotify.js` — PKCE OAuth flow, encrypted token storage, playback
  control, shortcuts, and the sleep timer.
- `main/lyrics.js` — lrclib.net lookup and LRC parsing.
- `main/weather.js` — wttr.in fetch and reverse-geocoding.
- `main.html` — inline `<style>` block (~1050 lines) extracted to
  `styles/main.css`; the single inline `<script>` block (~3000 lines)
  extracted, in original order, into ten `renderer/*.js` files loaded via
  `<script src>` tags: `core.js`, `fps-optimizer.js`, `hotkeys.js`,
  `settings.js`, `ui-utils.js`, `widgets-settings.js`, `clock-weather.js`,
  `beat-glow.js`, `spotify-widget.js`, `lyrics.js`.
- `package.json` — added `main/**/*`, `renderer/**/*`, and `styles/**/*` to
  `build.files` so electron-builder packages the new folders.

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
