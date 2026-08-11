# Changelog

All notable changes to Launcher are documented here.
Versioning: **Patch** (0.0.x) = bug fixes · **Minor** (0.x) = new features · **Major** (x.0) = large redesign.

---

## [3.47.1] — 2026-08-11

### Changed

- **Motion system refurbish (app-wide).** Introduced a single set of motion design
  tokens in `:root` (`--dur-1..5` durations, `--ease-out` / `--ease-emphasized` /
  `--ease-spring` / `--ease-in` easings) and routed the animations through them, so
  the whole app's timing and easing are now consistent and tunable from one place.
  The app's two signature curves are unchanged in feel but now flow through the tokens.
- **More premium content entrances.** The startup reveal cascade, modal rises, Settings
  section cascade, Widget Library open, widget-detail open, widget-library cards, and
  the generic fade-in now use an "emphasized" expo-out easing (`cubic-bezier(0.16, 1,
  0.3, 1)`) for a smoother, more expensive-feeling arrival. Modal/toast/detail exits now
  use a dedicated accelerate-away easing (`--ease-in`) — durations kept in sync with the
  200ms/240ms JS close timers so nothing gets cut off.
- **Smoother indeterminate loader.** The `.load-bar` sweep now animates a compositor-only
  `transform` (with `will-change`) instead of the `left` property, so it never triggers
  layout while looping. Travel is visually identical.
- **Consistent control transitions.** `transition: all` timings on interactive controls
  (buttons, chips, hotkey binds, file/clipboard/bluetooth toolbars, etc.) were unified to
  the token durations + the signature decel easing instead of a plain `ease`.

### Accessibility

- **Full reduced-motion support.** Replaced the partial `prefers-reduced-motion` block
  (which only covered a handful of selectors) with a global guard that collapses every
  animation and transition to effectively-instant when the OS "reduce motion" preference
  is on. Uses near-0 durations (not `animation: none`) so entrance animations still land
  on their final frame — elements never end up stuck invisible — and infinite loops
  (spinners, pulses, drifting grid/aurora) settle after one iteration.

### Files

- `styles/main.css` — motion tokens, token routing, emphasized entrances, exit easing,
  loader transform, reduced-motion guard.
- `package.json` — version bump.

---

## [3.47.0] — 2026-08-11

### Added

- **Spotify player — skeleton "loadup" while connecting.** When Spotify is connected
  and the player is fetching its first track, it now shows a shimmering skeleton
  mirror of the real player (vinyl disk, title/artist, controls, progress bar and
  volume) instead of holding on the idle "Not connected" card. The skeleton fades in
  and is swapped out the instant the first track payload arrives, so the connect →
  playing transition no longer flashes an empty or idle state.

### Changed

- **Nicer skeleton bars.** The lyrics and Spotify-player loading skeletons now use a
  glossy sweeping sheen (a narrow bright band that travels across a soft base) with a
  subtle depth hairline and staggered timing, instead of a flat low-contrast shimmer.
  The skeleton vinyl disk got a light-catching body with faint grooves and a swept
  highlight so it reads as a real disk. The lyrics loading skeleton's top bar now
  glows in the accent colour (like a real current line) so fetching the next song's
  lyrics reads as the same conveyor about to fill in.
- **Better "No lyrics" state.** The lyrics panel's empty state is now a rounded glassy
  icon chip (with a gentle breathing glow) above clearer copy — "No lyrics found /
  Nothing synced for this track yet" — instead of a bare icon and label.

---

## [3.46.0] — 2026-08-09

### Added

- **Claude Limit Auto-Continue — a new mini widget.** When you hit a usage limit in
  Claude (claude.ai), Cursor, Nimbalyst or any chat app, it reads when the limit
  resets, counts down, and at reset time focuses the chat window you picked and
  pastes + Enters a prompt so the conversation continues on its own. Detect the reset
  time by pasting the limit message, reading it from the clipboard, or leaving the
  clipboard watcher on (it recognises common "resets at…/in…/N-hour limit" phrasings);
  or set a time or countdown manually. Pick the exact target window (Cursor /
  Nimbalyst / Claude / browser — enumerated live), write the continue prompt, and arm
  it. The schedule survives reloads and fires even with the panel closed; if the app
  was closed within ~10 min of the reset it continues on next launch. It only resumes
  **after** the limit resets — it never bypasses a limit. Prompt delivery is via the
  clipboard (restored afterwards), and window focus uses the documented
  AttachThreadInput focus-steal; window handles/prompts are validated before use.

### Changed

- **Lyrics — next song is prepared from the queue (no more "loading" gap).** While a
  song plays, the widget now looks ahead at your Spotify queue and pre-fetches the
  next track's lyrics in the background, cached by track id. When the song changes the
  lyrics swap straight in instead of showing the fetching-skeleton for a second or two.
- **Lyrics — better loading on alt-tab.** The overlay stays visible (just unfocused)
  when you alt-tab, so background timers throttle and the highlighted line could sit
  stale until the next 2.5s poll; it now re-syncs immediately on window focus. The
  loading skeleton also fades in gently instead of popping.

### Files modified

- `main/claudeLimit.js` — **new**: versioned PowerShell helper (enumerate windows,
  AttachThreadInput focus + SendKeys paste/Enter), clipboard read + watcher, IPC.
- `renderer/claude-limit.js` — **new**: panel UI, reset-time parser, countdown
  scheduler that runs regardless of panel visibility, arm/disarm + test.
- `main.js` / `preload.js` — init + teardown `claudeLimit`; IPC bridge + clipboard-hit
  listener.
- `renderer/core.js` — new `claudeLimit` registry entry (category Productivity).
- `renderer/widgets-settings.js` — start/stop the watcher + resume schedule on toggle.
- `main.html` — load `renderer/claude-limit.js`.
- `main/spotify.js` — `simplifyTrack` now includes `duration_ms` (queue prefetch match).
- `renderer/lyrics.js` — next-song prefetch cache + instant cache-hit path; focus
  re-sync; skeleton fade-in.
- `styles/main.css` — Claude-limit widget styles; lyrics skeleton fade-in transition.
- `package.json` / `CHANGELOG.md` — version bump to 3.46.0 and this entry.

---

## [3.45.1] — 2026-08-09

### Changed

- **Loading bars & indicators — accuracy + animation pass across the app.**
  - **Shared loading system** in CSS: a reusable indeterminate **sweep bar**
    (`.load-bar`) for unknown-duration work, a polished **determinate fill**
    (`.app-progress-track` / `.app-progress-fill`) with accent gradient, glow, smooth
    eased width and a travelling sheen that **freezes on completion** (`.is-complete`),
    and a lightweight **ring spinner** (`.load-ring`).
  - **Spotify progress bar now moves smoothly and stays accurate.** It was only
    updated on Spotify's 2.5s poll, so it visibly stepped every 2.5 seconds. A 4×/sec
    ticker now advances the position by real elapsed time while playing (resyncing on
    every poll and on play/pause/seek/skip), and the bar's transition was switched to
    linear so it glides continuously. The current-time (and remaining-time) label
    updates every tick too.
  - **FPS Optimizer & Video Editor** (export + preview-proxy) bars adopt the shared
    determinate fill: accent-coloured, glowing, smoothly eased, resetting to 0% on
    start and freezing the sheen at 100% when done.
  - **File Search index build** shows a real animated indeterminate bar + ring spinner
    with the live (accurate) item count, instead of a bare spinner — correct, since
    the total file count is unknowable until the walk finishes.

### Files modified

- `styles/main.css` — shared `.load-bar` / `.app-progress-*` / `.load-ring` loaders;
  Spotify progress-bar transition → `0.25s linear`.
- `renderer/spotify-widget.js` — between-poll progress ticker (anchor + 250ms
  interpolation) using the lexical globals from `beat-glow.js`.
- `renderer/fps-optimizer.js`, `renderer/video-editor.js` — bars use the shared fill;
  toggle `is-complete` at 100%; reset on start.
- `main.html` — FPS progress bar markup → shared classes.
- `package.json` / `CHANGELOG.md` — version bump to 3.45.1 and this entry.

---

## [3.45.0] — 2026-08-09

### Added

- **File Search — a new mini widget (voidtools "Everything"-style).** Instant
  filename search across the folders you choose. It builds an in-memory index of
  your roots (your user folder by default; add any drive or folder) once, persists
  it to `%APPDATA%/main-launcher`, then answers every keystroke instantly by
  filtering that index. Supports Everything-style query syntax — wildcards
  (`*`, `?`), `ext:mp4,png`, `size:>10mb`, `folder:` / `file:`, `path:` (match the
  whole path), `case:` and `regex:`. Results show type, size and last-modified, and
  each row can **open the file**, **open its folder**, or **copy its path**. Sort by
  relevance, name, size or date. Build/rebuild the index from the panel with a live
  progress bar you can stop. All file actions go through Electron's shell — user
  input never touches a shell command line, and result actions pass a row index (not
  the path) so filenames with quotes/backslashes can't break the UI.

### Changed

- **Bluetooth Manager — v2, a major upgrade.**
  - **Turn the Bluetooth radio on and off** from the panel, via the WinRT
    `Windows.Devices.Radios` API (loaded lazily, only for radio commands, so the
    frequent list/scan path stays fast). A radio power card with a live on/off switch
    sits at the top of the panel; it hides itself gracefully where the API isn't
    available.
  - **Richer device data:** each device now reports its **type** (headphones, mouse,
    keyboard, controller, phone…) derived from its Bluetooth Class-of-Device, and
    **when you last used it** — shown on disconnected rows.
  - **Favourites + Auto-reconnect:** star the devices you care about (they sort to the
    top), and switch on **Auto** to have dropped favourites quietly reconnected while
    the panel is open (throttled, opt-in).
  - **Filter by name** when the list is long, and a combined `status` command fetches
    the radio state and device list in one round-trip on full refresh.

### Files modified

- `main/bluetooth.js` — PS script bumped to v2: WinRT radio on/off/state, device
  Class-of-Device → type mapping, last-seen/last-used timestamps, combined `status`
  command; new `bluetooth-status` / `bluetooth-radio-get` / `bluetooth-radio-set` IPC.
- `renderer/bluetooth.js` — radio power card + switch, favourites, auto-reconnect,
  name filter, device type/last-used in rows; full refresh uses `status`.
- `main/fileSearch.js` — **new** Everything-style engine: config + roots, streamed
  concurrent directory-walk index build with progress/cancel, disk persistence, query
  parser/matcher (wildcards/ext/size/path/regex/folder-file), file actions.
- `renderer/file-search.js` — **new** panel UI: instant search, streaming index
  progress, root management, sortable results with open/reveal/copy actions.
- `preload.js` — exposed `bluetoothStatus` / `bluetoothRadioGet` / `bluetoothRadioSet`
  and the full `fileSearch*` IPC surface (+ index-progress listener).
- `main.js` — require + init `main/fileSearch`.
- `main.html` — load `renderer/file-search.js`.
- `renderer/core.js` — Bluetooth registry entry → v2.0.0 with new features/keywords;
  new `fileSearch` registry entry (category **Searching**).
- `styles/main.css` — component styles for the Bluetooth radio/switch/rows and the
  File Search panel.
- `package.json` / `CHANGELOG.md` — version bump to 3.45.0 and this entry.

---

## [3.44.2] — 2026-08-04

### Added

- **ValClips Quality — total estimated time on the progress bar.** The encode bar
  now shows the **estimated total time** for the current step (e.g. `~2:45 total`)
  alongside the percentage, instead of just the time remaining — so you can see how
  long the whole operation is expected to take, not just what's left. The full
  process is also timed end-to-end: the finished row shows the actual total it took
  (clock starts at analysis, not while queued; resets on re-process).

### Files modified

- `main/valclips.js` — progress payloads now carry `totalSec` (estimated total for
  the step) from the encode passes and VMAF verify; job `startedAt`/`elapsedMs`
  timing stamped in `updateJob`, reset on re-queue.
- `renderer/valclips.js` — bar shows `~<total> total`; finished row shows the actual
  total time (`vcFmtElapsed`).
- `package.json` / `CHANGELOG.md` — version bump to 3.44.2 and this entry.

---

## [3.44.1] — 2026-08-04

### Changed

- **ValClips Quality — better TikTok quality + roomier limits.**
  - **Chroma boost (all modes).** Added `chroma-qp-offset=-2` to the x264 params so
    every encode spends ~2 QP steps more on colour than luma. TikTok crushes chroma
    hardest, so this protects saturated Valorant VFX (ability reds/blues, muzzle
    glow) that would otherwise smear after its re-encode.
  - **Leaner audio in Fit-size mode.** Audio now takes ~7% of the budget (40–128 kbps,
    down from up to 160k) so the picture keeps more bits under the size cap. Master
    and Smart Compress still use full-quality 320k audio.
  - **Max input size raised to 500 MB** (from 450). Files up to 500 MB are accepted
    and still crushed to below the 28 MB cap; larger ones are rejected up front.

### Files modified

- `main/valclips.js` — `chroma-qp-offset=-2` in `X264_HIGH_MOTION_PARAMS`, leaner
  audio budget in the Fit-size encoder, `maxInputSizeMB` default/clamp → 500.
- `renderer/valclips.js` — Max-input-size field default → 500.
- `package.json` / `CHANGELOG.md` — version bump to 3.44.1 and this entry.

---

## [3.44.0] — 2026-08-04

### Added

- **ValClips Quality — "Fit ≤ 28 MB" mode (now the default).** A new output mode
  crushes every clip to below a hard size cap using **2-pass ABR** x264 at a
  bitrate computed from the clip's duration (audio budgeted separately), with the
  same grain-sparing filters and high-motion tuning as the quality encoders — so
  it's the best-looking file that still fits. If a pass overshoots it re-encodes
  at a proportionally lower bitrate (up to 3 tries), and the cap is enforced in
  decimal MB so "below 28 MB" holds whether you read it as MB or MiB. VMAF/SSIM
  are still measured for the report. Two new settings back it:
  - **Target max size (MB)** — default **28**; the hard output cap.
  - **Max input size (MB)** — default **450**; larger files are rejected up front.

  So out of the box, any accepted clip up to 450 MB comes out under 28 MB. Master
  and Smart Compress remain available for quality-first work (and never remux in
  Fit-size mode, since a stream-copy can't hit a size target).
- **Widget Library — hide-info toggle.** A new eye button in the library header
  hides the wordy widget descriptions — the card blurbs and the detail view's long
  description + features list — for a compact, controls-first view. It's a single
  library-wide switch, remembered across sessions (`miniWidgetHideInfo`).

### Changed

- **All mini widgets are now credited to `ryota`.** ValClips Quality previously
  read `RYOTAscript`; the whole library is consistent again.

### Files modified

- `main/valclips.js` — Fit-size 2-pass encoder (`sizeCapEncode` + `encodeJob`
  branch, retry-on-overshoot), `targetSizeMB`/`maxInputSizeMB` settings + clamps,
  input-size guard in `addInputs`, remux disabled in Fit-size mode.
- `renderer/valclips.js` — "Fit ≤ N MB" mode segment, size settings in the drawer,
  result gauge tracks the cap in Fit-size mode.
- `renderer/widget-library.js` — hide-info toggle (`isWidgetInfoHidden` /
  `toggleWidgetInfo` / `updateWidgetInfoToggleBtn`); grid + detail respect it.
- `renderer/core.js` — ValClips `author` set to `ryota`.
- `main.html` — hide-info eye button in the Widget Library header.
- `styles/main.css` — active-state style for the hide-info toggle.
- `styles/vendor/tailwind.css` — regenerated (`npm run build:css`).
- `package.json` / `CHANGELOG.md` — version bump to 3.44.0 and this entry.

---

## [3.43.0] — 2026-08-03

### Added

- **New mini widget — ValClips Quality.** The standalone *valclips quality* tool
  (a maximum-effort TikTok exporter for ~20-second Valorant edits) is now built
  into the launcher as a mini widget, restyled to the app's own glass surfaces and
  accent theme rather than the original red/slate look. Drop a clip (or browse)
  and the Express pipeline analyzes it — VFR/HDR/grain/resolution/fps/motion — then
  either losslessly remuxes an already-perfect file or runs a VMAF + SSIM verified
  x264 encode (true CFR conversion, grain-sparing hqdn3d/nlmeans denoise, HDR
  tone-map, lanczos downscale, blurred-pad framing, high-motion x264 tuning) with
  auto-retry below target. Includes:
  - **Master** (near-lossless CRF 12) or **Smart Compress** (smallest visually-
    lossless file via a VMAF-target CRF search) modes, and Keep-aspect / 9:16 / 16:9
    output framing.
  - A **Tune** panel with a live 2-second before/after preview (denoise, pre-sharpen,
    saturation, contrast, aspect framing, experimental motion interpolation).
  - A motion-hotspot **Compare** viewer (wipe + side-by-side, zoom, frame-step) at
    the highest-motion moments, plus a size gauge, quality report and upload
    checklist on every finished export.
  - Its own bundled FFmpeg toolchain (a one-time ~170 MB download with VMAF),
    detected on PATH first, kept under `%APPDATA%/main-launcher/valclips` and
    entirely separate from the app's other FFmpeg usage.

  As with every mini widget, it's registered from a single `MINI_WIDGETS` entry
  (authored by **ryota**, like the rest of the library); the standalone
  `valclips-quality/` project is left untouched.

### Performance

- **Faster analysis & finalize, identical output.** The three source-scan passes
  (temporal noise, spatial noise, motion) are independent read-only scans and now
  run **concurrently** instead of one after another (~2-3× faster analysis on
  multi-core). Motion-hotspot detection also only reads the source, so it now runs
  **alongside the encode** rather than as a separate pass afterwards — it finishes
  early and is awaited for free, taking a full source scan off the critical path.
  Neither change alters any measured value, plan, or exported file. (The x264
  `veryslow` encode itself is left untouched — that slowness *is* the quality.)

### Files modified

- `main/valclips.js` — **new.** Full main-process engine: FFmpeg toolchain
  manager, deep ffprobe probe + noise/motion analysis, decision engine, filter/
  x264 arg builders, VMAF+SSIM verification, hotspot detection, job queue, live
  preview/compare rendering, settings and IPC.
- `renderer/valclips.js` — **new.** `renderValclipsPanel()` and the drop zone,
  job list, inline settings drawer, Tune and Compare modals — themed with `.vq-*`.
- `styles/main.css` — new `.vq-*` component styles (accent/neutral theme).
- `renderer/core.js` — `valclips` entry added to the `MINI_WIDGETS` registry.
- `main.js` — require + `init(ctx)` + teardown wiring for the widget.
- `preload.js` — `valclips*` IPC bridge (incl. `webUtils` drag-drop path resolve).
- `renderer/widgets-settings.js` — refresh the panel from `applyMiniWidgetPrefs`.
- `main.html` — load `renderer/valclips.js`.
- `styles/vendor/tailwind.css` — regenerated (`npm run build:css`).
- `package.json` / `CHANGELOG.md` — version bump to 3.43.0 and this entry.

---

## [3.42.1] — 2026-07-26

### Changed

- **Controller Macros — Templates picker now has a section per game.** The picker
  shows game tabs (**Skate**, **NBA 2K26**, **General**); clicking one shows only
  that game's categories, with a one-line hint about its control scheme. Keeps
  the growing library readable now that two games share the picker.

### Files modified

- `renderer/controller-macros.js` — game-tab sectioning in the template picker
  (`cmTemplateGameOf` / `cmTemplateCategoryOf` / `setCmTemplateGame`).
- `package.json` / `CHANGELOG.md` — version bump to 3.42.1 and this entry.

---

## [3.42.0] — 2026-07-26

### Added

- **Controller Macros — NBA 2K26 Pro Stick template library.** The Templates
  picker now includes NBA 2K26 moves alongside the Skate tricks, verified against
  2K26's controls guide and grouped into their own categories:
  - **Dribble:** Signature Size-up, Hesitation, Hesitation Escape, In & Out,
    Crossover, Crossover Escape, Between the Legs, Behind the Back, Stepback,
    Spin Move.
  - **Turbo moves** (hold RT): Momentum Behind the Back, Momentum Stepback.
  - **Shooting:** Jump Shot (flagged — it can't time the green window for you).
  - **Finishing** (RT + Pro Stick): 2-Hand Dunk, Flashy Dunk, Off-Hand Dunk,
    Layup, Floater / Runner.

  Directions follow a right-hand ball handler; the picker notes that left/right
  inputs mirror with your ball hand, and that live animations still depend on
  your left-stick movement. Turbo moves and dunks correctly hold **RT (R2)**
  while pushing the Pro Stick.

### Changed

- Skate template groups are now prefixed **"Skate ·"** so the two games read
  clearly in one picker. The picker header explains both control schemes.
- Widget entry bumped to v1.2.0 with NBA keywords (nba, 2k26, dribble, pro
  stick, dunk…) and an NBA feature line.

### Files modified

- `renderer/controller-macros.js` — NBA 2K26 helpers (`cm2kFlick`, `cm2kHold`,
  `cm2kTurbo`), 18 NBA templates, Skate group prefixes, picker header.
- `renderer/core.js` — widget description, keywords, features, version.
- `package.json` / `CHANGELOG.md` — version bump to 3.42.0 and this entry.

---

## [3.41.2] — 2026-07-25

### Fixed

- **Controller Macros — Skate templates corrected for Classic (Flick-It)
  controls.** Verified every trick's stick motion against EA's own Flick-It
  guide for the **Classic** control preset and fixed several that were wrong:
  - **Kickflip / Heelflip direction reversed.** Kickflip is down → **up-right**,
    Heelflip is down → **up-left** (nollie variants mirrored to match).
  - **Grabs now actually grab.** A grab requires a **trigger held** while the
    right stick points the grab — the old templates only moved the stick, so the
    game would have read them as flip tricks. Grabs now hold **L1** + stick.
  - **Manuals use the right stick.** Manual / Nose Manual now hold the **right
    stick ~halfway** (down / up), not the left stick.
  - Reworked Varial flips, 360 Flip (Tre), Laser Flip, Hardflip, Inward Heelflip
    (+ 360 versions), and Pop / 360 Shove-it (FS/BS) to the guide's motions, and
    added Nollie Varial Kickflip/Heelflip and 360 Hardflip / 360 Inward Heelflip.
  - Removed unverified entries (double flips, bigspin, boneless, no-comply
    kickflip/heelflip, quick-180). **No Comply (FS/BS)** are kept but flagged ⚠
    under a "verify in-game" group — their Classic input isn't confirmed yet.

  A note in the picker explains the **stance** caveat: if your skater's stance
  mirrors the game's prompts, kickflip/heelflip and FS/BS swap — fixable by
  swapping the two macros or dragging a corner on the visual pad.

### Files modified

- `renderer/controller-macros.js` — corrected `CM_TEMPLATES`, new `cmSkateGrab`
  (trigger-held) and right-stick `cmSkateManual` helpers, updated picker note.
- `package.json` / `CHANGELOG.md` — version bump to 3.41.2 and this entry.

---

## [3.41.1] — 2026-07-20

### Added

- **Controller Macros — full Skate trick library.** The Templates picker now
  covers the whole Skate *Flick-It* vocabulary instead of four starters, grouped
  into labelled categories you scroll through:
  - **Flip tricks:** Ollie, Nollie, Kickflip, Heelflip, Nollie Kickflip/Heelflip,
    Double Kickflip/Heelflip, Varial Kickflip/Heelflip, Hardflip, Inward
    Heelflip, 360 Flip (Tre), Laser Flip.
  - **Shove-its & spins:** Pop Shove-it (FS/BS), 360 Shove-it (FS/BS), Bigspin
    (FS/BS), Nollie Shove-it (FS/BS).
  - **No comply:** No Comply (FS/BS), No Comply 180, No Comply Kickflip/Heelflip,
    Boneless.
  - **Grabs** (hold the right stick in the air): Nosegrab, Tailgrab, Indy,
    Stalefish, Melon, Mute, Method, Crail.
  - **Manuals:** Manual, Nose Manual (left stick).
  - **Basics (any game):** hold-forward and a quick 180° flick.

  Each is a right-stick Flick-It motion (grabs hold a direction; manuals use the
  left stick), built as an editable starting point — exact flick corners vary by
  Skate title, so tweak them per game with the new visual joystick pad.

### Files modified

- `renderer/controller-macros.js` — Skate trick helpers (`cmSkateTrick`,
  `cmSkateSweep`, `cmSkateHold`, `cmSkateManual`), expanded `CM_TEMPLATES`, and a
  grouped/scrollable template picker.
- `renderer/core.js` — widget feature list updated for the full library.
- `styles/vendor/tailwind.css` — regenerated via `npm run build:css`.
- `package.json` / `CHANGELOG.md` — version bump to 3.41.1 and this entry.

---

## [3.41.0] — 2026-07-20

### Added

- **Controller Macros — visual joystick pad for stick steps.** Setting a stick
  move no longer means typing x/y percentages by hand. Every stick step now has
  a ◎ button that opens a round drag pad: drag the knob to pick any angle and
  strength (clamped to a real thumbstick's circular travel), or tap one of the
  nine direction presets on the 3×3 keypad (8 full-deflection directions plus a
  centre that recentres the stick). Diagonals hold ~full deflection on both
  axes, matching how a physical stick sits in a corner. The x/y number inputs
  stay for fine tuning and update live as you drag. Adding a new stick step
  drops you straight onto the pad. This makes flick- and aim-heavy games (Skate,
  Siege, Fortnite) far quicker to build combos for.

- **Controller Macros — one-click combo templates.** A new **Templates** button
  next to *Add macro* creates a ready-made macro you can tweak, so you start
  from a working combo instead of a blank list. Included starters: **Skate**
  flick tricks (Ollie, Kickflip, Heelflip, Pop Shuv-it) built on the right
  stick, plus **Hold left stick forward** and a **right-stick quick 180° flick**
  for any game. Each template opens in the editor so its steps are ready to
  adjust.

### Changed

- The Controller Macros widget entry (Widget Library) is now v1.1.0, with the
  joystick pad and templates in its feature list and new search keywords
  (stick, joystick, aim, flick, skate, siege, fortnite, template).

### Files modified

- `renderer/controller-macros.js` — joystick pad renderer, drag wiring, 8-way
  direction presets, template picker + insert, and stick-step id-tagged inputs.
- `styles/main.css` — joystick pad, knob, crosshair, and preset keypad styles.
- `renderer/core.js` — Controller Macros registry entry (version, description,
  features, keywords).
- `styles/vendor/tailwind.css` — regenerated via `npm run build:css`.
- `package.json` / `CHANGELOG.md` — version bump to 3.41.0 and this entry.

---

## [3.40.0] — 2026-07-20

### Added

- **Game Mode.** A new Widget Library entry (off by default) that watches the
  foreground window and notices when a game takes over — either a game you name
  by its process, or *any* app that goes borderless/exclusive fullscreen. Build
  a **profile** per game that automatically runs the actions you choose when it
  launches: mute your microphone, show the crosshair overlay, run the FPS
  optimizer, pop a notification, and switch on any other mini widgets you pick.
  When the game closes, Game Mode can undo everything it changed. Detection runs
  quietly in the background (a lightweight Win32 foreground-window watcher) while
  Game Mode is enabled; each profile is independent and editable.

- **Volume Mixer mini widget.** A per-application volume mixer, like the Windows
  tray mixer (off by default). Lists every app currently playing sound and lets
  you set each one's volume or mute it independently, plus master output volume
  and mute. Optional global hotkeys nudge the master volume up/down or toggle
  mute from anywhere. Powered by a small Core Audio helper process — nothing
  runs until the widget is switched on.

- **Discord Rich Presence mini widget.** Sets a fully customizable Rich Presence
  card on your Discord profile — the "Playing…" panel other people see (off by
  default). Customize the details and state lines, large/small images (from your
  Discord app's art assets), up to two link buttons and an elapsed-time clock,
  with a **live preview** card that shows exactly how it will look. Connects
  directly to your running Discord desktop app over its local IPC pipe; you
  supply your Discord Application ID. No third-party dependencies.

### Files changed

- `main/gameMode.js`, `renderer/game-mode.js` — **new** Game Mode (watcher +
  per-game action profiles)
- `main/volumeMixer.js`, `renderer/volume-mixer.js` — **new** Volume Mixer
  (Core Audio helper + per-app/master sliders + hotkeys)
- `main/discordRpc.js`, `renderer/discord-rpc.js` — **new** Discord Rich
  Presence (IPC pipe client + live-preview panel)
- `renderer/core.js` — three new `MINI_WIDGETS` registry entries + `Social`
  category
- `main.js` — wire the three modules (init, hotkey re-apply, quit teardown)
- `preload.js` — expose the three widgets' IPC surfaces
- `main.html` — load the three new renderer scripts + version label
- `renderer/widgets-settings.js` — enable/disable hooks in `applyMiniWidgetPrefs`
- `renderer/spotify-widget.js` — call `initGameMode()` on load
- `styles/main.css` — Volume Mixer, Game Mode and Discord preview styles
- `package.json`, `CHANGELOG.md` — version bump to 3.40.0

---

## [3.39.0] — 2026-07-20

### Added

- **Weather Enhanced mini widget.** An optional Widget Library entry (off by
  default) that expands on the header weather readout. Its detail panel shows
  current conditions with **feels-like** temperature, **humidity** and
  **wind**, plus a **3-day forecast**. Reads your location automatically or
  lets you pin any **city by name**, with a **refresh** button and a loading
  state. Units follow the existing °C/°F setting, so it stays consistent with
  the header. Built entirely on the existing weather service — no new
  permissions or accounts.

- **Countdown Timer mini widget.** An optional Widget Library entry (off by
  default). Start a countdown from quick presets (1–60 min) or a custom
  minutes/seconds duration, then **Start / Pause / Resume / Reset** it. While
  it runs, a live readout is pinned in the app header ("synced into the main
  UI") so you can watch it from anywhere and click it to jump back to the
  widget. It survives closing the Library panel and is resumed on app start;
  when it hits zero it alerts with a short beep and a toast.

- **Quick Notes Enhanced mini widget.** An optional Widget Library entry (off
  by default) that turns the Quick Notes card into a full mini editor:
  **multiple notes in tabs**, a **checklist mode** with tickable items, live
  **Markdown preview** (headings, bold/italic, lists, code, links), and
  **per-note version history** you can roll back to. Your existing scratch note
  is carried over the first time it's enabled, and left untouched when it's
  off — the basic single-note textarea is simply swapped back in.

- **Quick Launch Enhanced mini widget.** An optional Widget Library entry (off
  by default) that supercharges Quick Launch: organise apps into **folders**
  (Games, Work, or custom), **auto-detect installed Steam & Epic games** and
  file them into Games automatically, build **launch profiles** that open
  several apps at once, and see **running-app indicator dots**. The pinned-app
  cap is lifted while it's on; your existing apps are kept as-is when it's off.

### Changed

- Weather service (`main/weather.js`) now accepts an optional city override,
  returns feels-like temperature and a 3-day forecast alongside the existing
  fields, and caches the last reading (5 min) — serving it as a fallback when
  a refresh fails so the header never blanks. Existing callers are unchanged.

### Files changed

- `renderer/weather-enhanced.js` — **new** Weather Enhanced panel renderer
- `renderer/timer.js` — **new** Countdown Timer engine + panel + header readout
- `renderer/notes-enhanced.js` — **new** Quick Notes Enhanced (tabs, checklist,
  Markdown, history) + config panel
- `renderer/quick-launch.js` — **new** Quick Launch Enhanced (folders, game
  auto-detect, launch profiles, running indicators) + config panel
- `main/quickLaunch.js` — **new** backend: Steam/Epic game detection, running
  process query, batch launch, store-URI launch
- `main/weather.js` — city override, feels-like, forecast, caching
- `preload.js` — `getWeather` forwards options; Quick Launch Enhanced IPC bridges
- `renderer/core.js` — four new `MINI_WIDGETS` registry entries
- `renderer/widgets-settings.js` — wire new panels into `applyMiniWidgetPrefs`;
  per-app folder selector, lifted app cap, backup export/import of new keys
- `renderer/ui-utils.js` — folder-filtered app grid, running dots, store-URI
  launch routing
- `renderer/spotify-widget.js` — resume timer on startup (`initTimerWidget`)
- `main.js` — register `quickLaunch` module
- `main.html` — new script tags, Quick Launch folder/controls bar, Quick Notes
  enhanced container, header timer indicator, version labels
- `styles/main.css` + `styles/vendor/tailwind.css` — Quick Notes / Quick Launch
  Enhanced styles, timer indicator/button styles; regenerated Tailwind build
- `package.json` — version bump

---

## [3.38.1] — 2026-07-20

### Fixed

- Header version label was stuck at v3.36.0 (footer and Settings already
  showed the real version) — both now read from the same release number.

### Added

- `debug.md` — full closed-loop test report for the Controller Macros widget:
  every button, partial trigger pulls, left/right stick moves (±100%, ±50%,
  diagonals, recentre), D-pad diagonals and stuck-input safety verified on
  BOTH virtual pad types via two independent probes (Gamepad API for the
  DualShock 4 pad, raw XInput for the Xbox 360 pad). Includes known
  behaviours (recording needs app focus; trailing delays are trimmed) and a
  re-runnable XInput probe recipe. No app code changed for this — all tests
  passed as shipped.

### Files changed

- `debug.md` — **new** test report
- `main.html` — header + footer version labels
- `renderer/core.js`, `main.js`, `package.json`, `CHANGELOG.md` — version bump

---

## [3.38.0] — 2026-07-20

### Changed

- **Macros widget: mouse-button steps now use press-to-bind, like key steps.**
  The step editor used to make you pick "Left click" / "Right click" /
  "Middle click" from a dropdown. Now there's one "Mouse click" option (plus
  new "Hold mouse button" / "Release mouse button" options) — pick it, then
  physically press the mouse button you want, same flow as "Key press".
  - Side buttons (Mouse 4 / Mouse 5, the thumb buttons) can now be bound and
    actually play back correctly — previously they weren't recognized as a
    step target at all, and even the record/playback engine had no code path
    for them (`SendInput` only synthesized Left/Right/Middle).
  - Recording a macro now also captures side-button clicks instead of
    silently skipping them.

## [3.37.0] — 2026-07-20

### Added

- **New mini widget: Controller Macros.** Builds and replays PlayStation/Xbox
  controller button combos that games genuinely receive — a virtual
  DualShock 4 or Xbox 360 pad is plugged into Windows through the free
  ViGEmBus kernel driver (the same one DS4Windows uses), and macros press
  ✕ / □ / L2 / R1 (and more) on it.
  - Step editor: button taps, holds/releases, partial trigger pulls (L2/R2 %),
    stick moves, and delays — PlayStation-labelled buttons with Xbox
    equivalents shown alongside.
  - Record combos straight from a real controller (Gamepad API) when one is
    connected.
  - Per-macro hotkeys with the same Pressed / Hold / Toggle / Released trigger
    modes, repeat counts (incl. "until stopped") and playback speed as the
    Macros widget; keyboard *and* mouse-button triggers pass through to the
    focused game.
  - Enable/disable all triggers with a bindable toggle key (default F10).
  - Switch what games see — PlayStation (DualShock 4) or Xbox 360 (best
    compatibility) — live from the panel; the pad re-plugs instantly.
  - Guided driver setup: the panel detects whether ViGEmBus is installed and
    offers a download link and a re-check button; everything fails gracefully
    (with Logger entries) when the driver is missing.
  - Playback engine follows the established helper-process pattern
    (PowerShell-compiled C# talking over stdin/stdout) and never leaves
    buttons stuck: sequences release everything they pressed on stop, crash
    recovery re-plugs the pad automatically once.
  - Honest note in the panel: some anti-cheat titles may ignore or dislike
    virtual controllers.
- Vendored `Nefarius.ViGEm.Client.dll` 1.17.183 (BSD-3-Clause) under
  `main/vendor/` — see `main/vendor/VENDOR.md`.

### Changed

- The Macros widget's background key watcher now also serves Controller
  Macros trigger hotkeys (one shared helper process instead of two); its own
  behaviour is unchanged. Hotkeys can no longer be bound to both a keyboard
  macro and a controller macro at once.

### Files changed

- `main/controllerMacros.js` — **new**: virtual pad engine, storage, IPC, triggers
- `main/vendor/Nefarius.ViGEm.Client.dll`, `main/vendor/VENDOR.md` — **new**
- `main/macros.js` — external key-watch subscription API (shared watcher)
- `main.js` — module wiring + hotkey re-apply
- `preload.js` — `controllerMacros*` IPC bridge
- `renderer/controller-macros.js` — **new**: panel UI, step editor, pad recording
- `renderer/core.js` — registry entry, version bump
- `renderer/widgets-settings.js` — enable/disable hook
- `renderer/spotify-widget.js` — type-to-search yields while binding
- `main.html` — script tag, version bump
- `styles/vendor/tailwind.css` — rebuilt (driver-banner classes)
- `package.json`, `CHANGELOG.md` — version + changelog

---

## [3.36.0] — 2026-07-19

### Changed

- **The dashboard Mini Widgets strip now shows favourites only.** Enabling a
  widget no longer pins it to the main screen — starring it does. Enabled
  widgets keep running exactly as before; they just live in the Widget
  Library until you favourite them. With no favourites yet, the strip shows
  a "Favourite widgets in the Library to pin them here" hint instead.
- **Settings page reorganised into named groups.** The long scroll is now
  clustered under five labelled headers with divider lines:
  *Layout & Apps* (Pinned Apps, Widgets, Mini Widgets), *Look & Feel*
  (Appearance, Background), *System* (Behavior, Hotkeys),
  *Spotify* (Integration, Spotify Hotkeys, Spotify Extras), and
  *Data & Maintenance* (FPS Optimizer, Backup & Logs). Related settings now
  sit together — Mini Widgets moved up next to the other layout sections and
  Spotify Hotkeys moved into the Spotify cluster. Group headers ride the
  same entrance cascade as sections and step aside while you search.

### Files changed

- `main.html` — section reorder + group headers, version bump
- `renderer/widget-library.js` — dashboard strip filters to favourites
- `renderer/widgets-settings.js` — search hides group headers; stagger
  cascade includes them
- `styles/main.css` — group header styling + animations
- `package.json`, `main.js`, `renderer/core.js` — version bump

---

## [3.35.1] — 2026-07-19

### Fixed

- **Widget Library search text is white.** The search box used the browser's
  default dark placeholder colour, making "Search widgets…" hard to read on
  the dark panel. Typed text and placeholder are now white, matching the
  Settings search box.
- **Category chips no longer get cut off.** With all categories present, the
  last chip clipped at the panel's right edge behind an invisible horizontal
  scroll. The chip bar now wraps onto a second line instead, with a hairline
  divider under it separating the header from the widget grid.
- **Card rows line up.** Cards with one-line descriptions were shorter than
  their neighbours, so the enable toggles sat at different heights across a
  row. Descriptions now reserve two lines and card footers align.
- **Hover effects no longer clip.** The top row of widget cards and the
  dashboard chips had their hover lift / selection ring / shadow cut off by
  their scroll containers; both got breathing room.
- **Widget detail panels get bottom padding** so embedded settings (macros,
  video editor, …) don't end flush against the panel edge, and the empty
  search state got a proper icon + hint instead of a bare sentence.

### Files changed

- `styles/main.css` — search input colours, chip-bar wrap + divider, card
  description min-height, scroll-container padding, strip clip fix
- `renderer/widget-library.js` — card footer alignment, detail bottom
  padding, version-label contrast
- `main.html` — category bar wraps, richer empty state, version bump
- `styles/vendor/tailwind.css` — rebuilt
- `package.json`, `main.js`, `renderer/core.js` — version bump

---

## [3.35.0] — 2026-07-19

### Added

- **Widget Library.** Mini Widgets moved out of the Settings scroll into a
  dedicated, searchable library (open it from the new "Browse Widgets"
  button on the dashboard, or from Settings → Mini Widgets). The library
  shows every widget as a card — icon, name, description, category,
  version, enable toggle and favourite star — and clicking a card opens a
  detail panel with the full description, feature list, status, hotkey
  binding, and that widget's entire settings panel (macros, clipboard,
  Bluetooth, video editor, etc. all configure from here now).
- **Instant fuzzy search.** The library search matches names, descriptions,
  categories and per-widget keywords while you type — case-insensitive,
  extra-space-tolerant, and forgiving of small typos ("spotfy" still finds
  Spotify Enhanced). `music` finds Spotify Enhanced; `aim` finds Crosshair.
- **Categories.** Widgets are organised into categories (Gaming, Audio,
  Media, Productivity, System, Displays, Clipboard, Spotify, …) with a
  filter chip bar. The selected category is remembered across restarts.
- **Favourites.** Every card and detail panel has a ★ that pops when
  toggled. Favourites always sort before other widgets in the library, on
  the dashboard strip, and in the Settings summary. Saved across restarts
  and included in settings export/import.
- **Recently used.** The last six widgets you opened or enabled get a small
  clock badge in the library. Persisted across restarts.
- **Dashboard Mini Widgets strip.** The dashboard now shows a compact row
  of chips for your favourite + enabled widgets only — clicking a chip
  jumps straight to that widget's detail panel. Everything else stays in
  the library, so the dashboard never grows as widgets are added.
- **Keyboard navigation.** Inside the library: arrow keys move between
  cards, Enter opens the selected widget, Space toggles its favourite,
  Ctrl+F (or just typing) focuses search, Esc closes the detail panel then
  the library.

### Changed

- **The widget registry (`MINI_WIDGETS` in `renderer/core.js`) is now the
  single source of truth.** Each entry carries id, name, descriptions,
  category, keywords, version, author, features, optional hotkey and
  optional config panel. The library, search index, dashboard strip and
  Settings summary are all generated from it — a future widget appears
  everywhere by adding one registry entry (see the comment block above
  `MINI_WIDGETS` for the field reference).
- **Settings → Mini Widgets** is now a one-card summary (enabled/favourite
  counts + chips + "Open Widget Library" button) instead of eight stacked
  config panels — the Settings scroll got dramatically shorter. All
  existing enable states, hotkeys and per-widget settings carry over
  unchanged (same storage keys, no migration needed).

### Files changed

- `renderer/widget-library.js` — new: library modal, search, categories,
  favourites, recents, detail panel, keyboard navigation, dashboard strip
- `renderer/core.js` — registry metadata (categories, keywords, versions,
  features, panel renderers) + `MINI_WIDGET_CATEGORIES`, version bump
- `renderer/widgets-settings.js` — Settings section becomes a summary;
  export/import now carries favourites/recents/last category; strip refresh
  wired into `applyMiniWidgetPrefs()`
- `main.html` — Widget Library modal, dashboard Mini Widgets strip, script
  tag, Settings heading, version bump
- `styles/main.css` — library/card/chip/detail/strip styles + animations
- `styles/vendor/tailwind.css` — rebuilt (`npm run build:css`)
- `package.json`, `main.js` — version bump

---

## [3.34.1] — 2026-07-18

### Fixed

- **The Spotify Enhanced strip no longer gets stuck on screen.** A side
  effect of the 3.34.0 offline change: the bundled Tailwind stylesheet
  loaded *before* `styles/main.css`, while the old CDN injected it *after*
  — so the `hidden` utility class lost every tie against component styles
  like the Enhanced strip's `display: flex`, leaving the panel visible
  even when it should hide. The Tailwind stylesheet now loads last, which
  restores the exact cascade the app always had.
- **Parallax no longer blurs the app.** The whole-panel 3D tilt forced
  Chromium to rasterize and resample the entire window while the mouse
  moved, softening all text. The tilt is removed; the actual parallax —
  background drifting away from the cursor, icons and widgets leaning
  toward it — is unchanged and uses pixel-snapped offsets, so everything
  stays sharp with the effect on.

### Files changed

- `main.html` — stylesheet order (Tailwind last), parallax description,
  version bump
- `renderer/parallax.js` — 3D panel tilt removed
- `renderer/background.js` — comment update
- `package.json`, `main.js`, `renderer/core.js` — version bump

---

## [3.34.0] — 2026-07-18

### Changed

- **The app now works fully offline and starts faster.** Tailwind CSS and
  Font Awesome used to load from the internet on every launch — with no
  network (or a slow/blocked one) the whole UI rendered as unstyled text
  with empty boxes where every icon should be. Both are now bundled with
  the app: a pre-built static Tailwind stylesheet
  (`styles/vendor/tailwind.css`) and Font Awesome Free 6.5.1
  (`styles/vendor/fontawesome/`). Zero CDN requests at startup, and the
  Tailwind runtime JIT compiler (which regenerated all CSS in the renderer
  on every launch) is gone entirely — styles are plain CSS applied before
  first paint.
- **The UI fonts (Inter, JetBrains Mono) are bundled too.** They were
  loaded from Google Fonts via `styles/main.css`, so offline the whole app
  silently fell back to system fonts. They now ship in
  `styles/vendor/fonts/`.
- Dev note: adding a new Tailwind class in HTML or renderer JS now requires
  `npm run build:css` to regenerate the vendored stylesheet (see
  `tailwind.config.js` / `styles/vendor/README.md`).

### Files changed

- `main.html` — CDN `<script>`/`<link>` replaced with local stylesheets
- `styles/vendor/tailwind.css` — new, generated static Tailwind build
- `styles/vendor/fontawesome/**` — new, vendored Font Awesome Free 6.5.1
- `styles/vendor/fonts/**` — new, vendored Inter + JetBrains Mono woff2
- `styles/main.css` — Google Fonts `@import` now points at the local files
- `styles/vendor/README.md` — new, provenance + licensing + regen notes
- `tailwind.config.js`, `tailwind.input.css` — new, dev-only build inputs
- `package.json` — `build:css` script, dev-only `tailwindcss` +
  `@fortawesome/fontawesome-free`, version bump
- `main.js`, `renderer/core.js` — version bump

---

## [3.33.6] — 2026-07-18

### Fixed

- **Transparent blur no longer breaks after the screen resolution changes.**
  The live view's screen alignment was computed once, when the blur
  started. Any later display change — a game switching the ultrawide to
  1920×1080 fullscreen, a monitor scale change, plugging a display in or
  out — left the video sized and placed for the OLD screen: wrongly scaled
  blur on part of the window and the sharp desktop showing through the
  rest. The app now watches Windows display events and re-syncs the
  backdrop (and wallpaper frost) automatically within a moment of any
  resolution or monitor change.

### Files changed

- `main/backgrounds.js` — display-change events forwarded to the renderer
- `preload.js` — `onDisplayChanged` bridge
- `renderer/background.js` — re-sync backdrop geometry on display changes
- `main.html`, `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.33.5] — 2026-07-17

### Fixed

- **Transparent blur no longer breaks when Parallax is enabled.** With
  Parallax on, moving the mouse tilts the whole panel in 3D — and a heavily
  blurred live-video layer inside a perspective-rotated panel makes the
  compositor drop or blacken parts of it, which showed as half the window
  blurred wrong / half showing the sharp desktop (reproduced at just 0.6°
  of tilt). The screen-aligned backdrop also must stay glued to the real
  desktop, so tilting/drifting it was wrong regardless. Now, while the
  Transparent backdrop (live view or wallpaper frost) is active, Parallax
  pauses the panel tilt and background drift but keeps the icon and widget
  motion — and resumes fully on any other background.

### Files changed

- `renderer/parallax.js` — skip tilt + background drift while a backdrop layer is active
- `renderer/background.js` — refresh parallax when a backdrop activates
- `main.html`, `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.33.4] — 2026-07-17

### Fixed

- **High Blur values no longer wash out parts of the Transparent background.**
  At high blur (especially the 40px max), large areas of the card faded to
  near-transparency — the raw desktop showed through the frost, looking
  broken on half the screen. Two causes, both fixed:
  - the screen-sized live video overflowed the blurred layer by hundreds of
    pixels, so the blur ran out of rendered image data to sample — it's now
    clipped to the layer first (`#bg-backdrop`);
  - the background's edge bleed (48px) was smaller than the area a 40px blur
    samples (~60px), so edges faded — the bleed is now 96px, comfortably
    above the maximum. This also cleans up edge softness on custom
    image/video backgrounds at high blur.

### Files changed

- `main.html` — backdrop clip wrapper, version
- `styles/backgrounds.css` — 96px bleed, `#bg-backdrop` rule
- `renderer/background.js` — alignment offset updated to the new bleed
- `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.33.3] — 2026-07-17

Debugging pass (log-driven): fixed the three most frequent recurring issues.

### Fixed

- **Spotify going offline no longer floods the log.** Network failures
  (offline, DNS down, firewall while gaming) were logged as a full error
  with stack trace on every poll — dozens of identical entries per session.
  Now one warning when connectivity drops, one line when it returns; real
  (non-network) failures still log as errors.
- **Stale monitor preference now heals itself.** Windows can permanently
  change display ids (GPU/driver updates), so the saved monitor was warned
  about on every single launch, forever. The preference now resets to the
  primary display once (with a clear log line); picking a monitor again is
  one click in Settings.
- **A failed live-capture start can no longer leave the app invisible to
  screenshots.** If the screen stream failed right after the capture
  exclusion was switched on, the exclusion stayed on with no blur running.
  It's now always lifted when the stream stops or fails.

### Improved

- The background color sampler reuses one canvas instead of allocating a
  new one every few seconds (less garbage-collection churn).

### Files changed

- `main/spotify.js` — network-failure latch (warn once, note recovery)
- `main/displaySettings.js` — self-healing display preference
- `renderer/background.js` — capture-exclusion cleanup on failed start; reused sampler canvas
- `main.html`, `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.33.2] — 2026-07-16

### Fixed

- **Removed the false "Crash handler binaries missing" error on every
  startup.** Electron 42 no longer ships `chrome_crashpad_handler.exe` /
  `chrome_wer.dll` on Windows (verified against a fresh official download —
  crash handling now runs from `electron.exe` itself), so the old file check
  flagged a perfectly healthy install. The check now understands both
  layouts: it still catches a genuinely broken/quarantined old-style
  install, verifies the crash reporter actually started, and otherwise logs
  "Crash handler verified".

### Files changed

- `main.js` — version-aware crash-handler verification
- `main.html`, `renderer/core.js`, `package.json` — version bump

---

## [3.33.1] — 2026-07-16

### Fixed

- **Auto theme color detection now works while the live blur is running.**
  The screen-thumbnail sampler came back empty whenever the live capture
  stream was active (the two capture paths conflict), so the Auto accent
  stayed white. While the live view is on, colors are now sampled straight
  from that stream — cropped to the window's own area, so the tint tracks
  exactly what's behind the app — with the thumbnail sampler still used
  when no stream is running.

### Files changed

- `renderer/background.js` — sample the live stream directly; optional source rect in the color sampler
- `main.html`, `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.33.0] — 2026-07-16

### Fixed

- **Transparent blur really has rounded corners now.** The Windows
  compositor blur used in v3.31–3.32 always paints a square patch — window
  regions can't clip it on Electron's transparent windows, which is why the
  corners stayed sharp. Replaced it entirely: the app now shows a **live
  video stream of the screen behind the window** (the window excludes
  itself from the capture), blurred inside the card — so the blur is
  clipped by the card's own 32px rounded corners, pixel-perfect.

### Changed

- **The Blur slider now controls real blur strength on Transparent** (the
  old compositor blur had a fixed OS strength). Brightness and Saturation
  also apply to the same live view, and everything stays live as windows
  move behind the app.
- **Heads-up:** while Transparent effects are active, the app hides itself
  from screenshots and screen recordings — that exclusion is what lets it
  see (and blur) what's behind it. Turn the effects off and it captures
  normally again.
- The Auto theme's behind-window color detection also no longer sees the
  app itself while the live view is running, so its colors track the real
  background even more accurately.
- If the live capture isn't possible, everything falls back to the frosted
  wallpaper look from v3.30.0 automatically. The old blur helper script is
  cleaned out of the data folder.

### Files changed

- `main/backgrounds.js` — live-capture IPC (screen source + capture exclusion), compositor-blur machinery removed
- `preload.js` — `backgroundLiveCapture` bridge (replaces `backgroundSetBlurBehind`)
- `renderer/background.js` — live screen stream management, alignment, fallback
- `main.html` — `#bg-live` video layer, hint text, version
- `styles/backgrounds.css` — backdrop layer comment
- `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.32.0] — 2026-07-16

### Added

- **Auto theme now watches the screen behind the window on Transparent.**
  With the Transparent background and the Auto accent (or Auto text color)
  selected, the app samples what's actually visible behind and around the
  window every few seconds — and again right after you drag the window —
  and live-tints the accent glow and text to match. Move a colorful game,
  video, or wallpaper behind the app and the theme follows it.
  - Sampling is weighted toward colorful, bright pixels (a red neon sign
    outweighs a grey wall) and dark picks are brightened into readable
    accents, same as for custom media.
  - Tiny color drifts are ignored so the theme doesn't flicker; if sampling
    is unavailable the Auto theme simply keeps its normal color.

### Fixed

- **Live blur no longer has sharp square corners.** While the Transparent
  blur is on, the window is clipped to the same 32px rounded shape as the
  app card, so the blur haze follows the round corners instead of sticking
  out past them as a hazy rectangle. The clip is removed together with the
  blur and adapts to the display's DPI scale (re-checked when the window
  moves between monitors).

### Files changed

- `main/backgrounds.js` — screen sampling IPC handler; rounded clip region in the blur script
- `preload.js` — `backgroundSampleBehind` bridge
- `renderer/background.js` — behind-window sampling loop wired into the Auto accent/text theme
- `main.html` — hint text + version
- `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.31.0] — 2026-07-15

### Added

- **Real live blur on the Transparent background.** Turning up **Blur** now
  asks the Windows compositor itself to blur whatever is actually behind the
  window — your desktop, games, browsers, everything — for a true frosted
  acrylic look that stays live as things move behind the app.
  - Uses the same Windows API technique as TranslucentTB
    (`SetWindowCompositionAttribute` / blur-behind); no extra installs needed.
  - Windows controls the blur strength, so the Blur slider acts as the on/off
    switch for it on this background.
  - **Brightness** still dims the (now blurred) live view, and if the API is
    ever unavailable the app automatically falls back to the v3.30.0 frosted
    wallpaper — nothing breaks.
  - All other backgrounds are untouched; the blur is switched off the moment
    you leave Transparent.

### Files changed

- `main/backgrounds.js` — blur-behind PowerShell script + `background-set-blur-behind` IPC handler
- `preload.js` — `backgroundSetBlurBehind` bridge
- `renderer/background.js` — live-blur toggle with wallpaper-frost fallback
- `main.html` — hint text + version
- `renderer/core.js`, `main.js`, `package.json` — version bump

---

## [3.30.0] — 2026-07-15

### Added

- **Background effects now work on the Transparent background.**
  - Turning up **Blur** (or Saturation, or Brightness above 100%) shows a
    frosted view of your desktop wallpaper behind the window — positioned to
    line up exactly with the real desktop, tracked live while you drag the
    window — so the app looks like true acrylic glass. (Windows 10 offers no
    API to blur the live desktop itself; this is the standard technique.)
  - **Brightness below 100% on its own dims the real see-through view** with a
    translucent veil, keeping actual live transparency.
  - With no effects active, Transparent stays genuinely see-through, exactly
    as before.
- **Text color themes (Settings → Background → Text color).** A second swatch
  row recolors the app's text — headings, labels, values, and lyrics keep
  their bright-to-dim hierarchy in the chosen tint:
  - **Auto** follows the accent theme; 6 soft presets (Cream, Mint, Sky,
    Lilac, Rose, Gold); a **custom color picker** for anything else. Dark
    picks are automatically brightened into readable pastels.
  - Default is the original white palette, pixel-for-pixel; colored
    functional text (Spotify green, error red) is never touched.

**Files changed:** `renderer/background.js`, `main/backgrounds.js`,
`preload.js`, `styles/backgrounds.css`, `main.html`, `renderer/core.js`,
`main.js`, `package.json`, `CHANGELOG.md`

---

## [3.29.0] — 2026-07-15

### Added

- **Transparent background (Settings → Background).** A new "Transparent"
  card (checkerboard preview) removes the background entirely — the launcher
  becomes a true glass sheet floating over your desktop, showing whatever is
  behind it. The Electron window was always created transparent, so this
  simply stops painting anything over it. Grid, scanlines, grain, and
  vignette can still be layered on top, and the Panel glass slider controls
  how see-through the widgets themselves are.
- **Themes now tint the Quick Launch tiles.** With any non-white accent
  (picked or Auto), the tile face behind each pinned app icon takes a deep
  shade of the accent color and its border picks up an accent tint — so the
  whole Quick Launch row visibly matches the theme. The default white theme
  keeps the original neutral tiles pixel-for-pixel.

**Files changed:** `renderer/background.js`, `styles/main.css`,
`styles/backgrounds.css`, `main.html`, `renderer/core.js`, `main.js`,
`package.json`, `CHANGELOG.md`

---

## [3.28.0] — 2026-07-15

### Added

- **Accent themes (Settings → Background → Accent theme).** One tap recolors
  every "glow" surface in the app — the window halo, widget hover glow,
  CPU/RAM bars, Spotify progress bar and beat-pulse, current-lyric glow,
  sliders, toggles, live dots, and app-icon hover — while text stays white
  for readability:
  - **Auto (default)** follows the active background: each built-in scene has
    a matching accent (Aurora → teal, Sunset → orange, …), My Scene uses your
    first color, and for your own images/videos it **samples the media's
    dominant color** automatically.
  - 7 fixed themes (Frost, Emerald, Ice, Violet, Rose, Amber, Crimson) plus a
    **custom color picker** swatch for any color. Dark picks are auto-brightened
    so glows stay visible. Default is white — nothing changes until you theme.
- **My Scene — build your own animated background.** A new gallery card with
  three color pickers and a "drifting color blobs" toggle: your colors become
  a live animated scene (light pools + optional wandering blobs), previewed
  in the gallery card and applied in real time as you drag the pickers.
- **Media fit control** for your own backgrounds — Fill (crop), Fit
  (letterbox), or Stretch.

**Files changed:** `main.html`, `styles/main.css`, `styles/backgrounds.css`,
`renderer/background.js`, `renderer/settings.js`, `renderer/spotify-widget.js`,
`renderer/beat-glow.js`, `renderer/core.js`, `main.js`, `package.json`,
`CHANGELOG.md`

---

## [3.27.0] — 2026-07-15

### Added

- **Background Studio (Settings → Background).** The app's background is now
  fully customisable:
  - **7 built-in animated scenes** — Monochrome (the original look), Aurora,
    Prism (colorful drifting mesh-gradient blobs), Nebula (deep space with a
    live twinkling starfield), Sunset, Ocean, and Bokeh (floating warm light
    orbs). All GPU-friendly: gradient/transform CSS animation plus a lightweight
    canvas for the particle scenes, paused automatically while the window is
    hidden.
  - **Your own backgrounds** — add any image, GIF, or looping video (mp4/webm/
    mov/m4v). Files are copied into `%APPDATA%/main-launcher/backgrounds` so
    they survive moves and app updates; the gallery shows live thumbnails and
    lets you switch or remove them anytime. A missing/corrupt file safely
    falls back to the default scene.
  - **Background effects** — blur (0–40px), brightness, saturation, animation
    speed, live film grain, and a vignette, all applied instantly.
  - **Panel glass slider** — real glassmorphism: lowers the widget panels'
    opacity so the background glows through the frosted backdrop blur,
    Apple-style.
  - The existing **grid overlay and scanlines are now toggleable** (both still
    on by default — the default look is unchanged).
  - One-click **Reset background to default**, and everything is included in
    Settings **export/import**.
- Parallax now moves the entire background stack (including custom media and
  particle scenes) as the far layer.

**Files changed:** `main.html`, `styles/main.css`, `styles/backgrounds.css` (new),
`renderer/background.js` (new), `renderer/parallax.js`,
`renderer/widgets-settings.js`, `main/backgrounds.js` (new), `preload.js`,
`main.js`, `renderer/core.js`, `package.json`, `CHANGELOG.md`

---

## [3.26.1] — 2026-07-15

### Fixed

- **Parallax: cursor leaving the app now drifts slowly back to center**
  instead of snapping — the return uses a much floatier ease (~3× slower
  than cursor tracking), and switching focus to another app triggers the
  same gentle return.
- **Parallax no longer blurs the app.** Three causes, all fixed:
  - Foreground layers (icons, widgets) and the background grid were being
    offset by fractional pixels, smearing text and the 1px grid lines
    across two pixels. They now move in whole pixels only.
  - The panel tilt was strong enough to visibly soften rotated text; the
    max lean is reduced 1.8° → 1.1° with a more distant perspective, where
    the softness is imperceptible.
  - The panel kept a 3D transform even at rest (cursor centered/away),
    leaving the whole app composited off a rasterized layer that renders
    text slightly soft. Once the motion settles at center, every parallax
    transform is now removed entirely, returning the app to normal
    pixel-perfect rendering.

**Files changed:** `renderer/parallax.js`, `main.html`, `renderer/core.js`,
`main.js`, `package.json`, `CHANGELOG.md`

---

## [3.26.0] — 2026-07-15

### Added

- **Parallax now tilts the whole panel in 3D.** With the Parallax effect
  enabled (Settings → Appearance), the entire window leans toward your
  cursor — the corner under the mouse lifts slightly toward you (max ~1.8°,
  with perspective) — on top of the existing background/foreground layer
  drift. Same spring smoothing, same settle-and-stop animation loop, still
  off by default.
  - The startup fade-in animation used to pin the panel's transform
    permanently (`fill: forwards`); it's now released on the first tilt so
    the effect actually applies (no visual change — its final frame equals
    the natural state).

**Files changed:** `renderer/parallax.js`, `main.html`, `renderer/core.js`,
`main.js`, `package.json`, `CHANGELOG.md`

---

## [3.25.0] — 2026-07-15

### Added

- **Parallax effect (Settings → Appearance, off by default).** When enabled,
  the window gains a subtle sense of depth as you move the mouse: the
  background scene and grid drift slightly *away* from the cursor while the
  Quick Launch icons and widget cards lean gently *toward* it. Cursor leaving
  the window floats everything back to center.
  - Motion is spring-smoothed and the animation loop only runs while layers
    are actually moving — an idle window costs nothing, and the effect uses
    GPU-composited transforms only.
  - Modals, the header, and the footer stay perfectly still — UI you're
    interacting with never shifts under the cursor.
  - The preference is included in Settings export/import backups.

**Files changed:** `renderer/parallax.js` (new), `main.html`,
`renderer/widgets-settings.js`, `renderer/core.js`, `main.js`,
`package.json`, `CHANGELOG.md`

---

## [3.24.0] — 2026-07-15

### Added

- **Motion & polish pass — smoother animations everywhere, cleaner look.**
  - **Startup reveal cascade:** the header, Quick Launch label, app icons,
    widget cards, and footer now rise into place one after another when the
    app opens (icons stagger left-to-right; plays on first render only, so
    reordering apps in Settings doesn't replay it).
  - **Modals now animate closed, not just open.** Settings, FPS Optimizer,
    and Lyrics previously snapped shut instantly; all three now fade out
    with a gentle sink. FPS Optimizer and Lyrics also gained a proper
    entrance (rise + fade — they had none). Settings sections cascade in
    one after another when the panel opens, and sections re-appearing while
    searching play the same little rise.
  - **Toasts slide up** from the bottom edge and drop away on dismiss
    instead of blinking in and out.
  - **Ambient background life:** two very faint light pools slowly drift
    behind the grid (pure GPU transform animation — no measurable cost).
  - **Micro-interactions:** every button dips slightly while pressed; app
    icons get a one-shot light sheen sweeping across the tile on hover;
    widget cards float up 3px on hover.
  - **Cleaner details:** section labels are now uppercase for a more
    deliberate look; text inputs and selects ease their border color
    instead of snapping.
  - All decorative motion (background drift, reveal cascade, sheen) is
    disabled automatically when Windows' "reduce motion" accessibility
    setting is on. Functional feedback (toasts, stat bumps) stays.

**Files changed:** `styles/main.css`, `main.html`, `renderer/ui-utils.js`,
`renderer/settings.js`, `renderer/fps-optimizer.js`, `renderer/lyrics.js`,
`renderer/widgets-settings.js`, `renderer/core.js`, `main.js`,
`package.json`, `CHANGELOG.md`

---

## [3.23.0] — 2026-07-15

### Added

- **Clipboard History now records images and files, not just text.**
  - Copying an image (screenshots, right-click → Copy Image in a browser,
    image editors) saves it to history with a thumbnail preview and its
    dimensions. Clicking the entry puts the image back on the clipboard,
    ready to paste. Full-size copies are cached in
    `%APPDATA%/main-launcher/clipboard-images/` and cleaned up when the
    entry is deleted, cleared, or evicted by the 50-item cap.
  - Copying files or folders in Windows Explorer records the copied paths.
    The entry lists the file names (first 3, with a "+N more" overflow and
    full paths in the tooltip). Clicking it re-copies the files so they can
    be pasted into any folder; files that have since been deleted are
    skipped, with a clear message if none remain.
  - Text, image, and file entries share the same pin / delete / clear
    controls and the existing 50-item history cap. Existing history files
    from older versions load unchanged.
  - Sensitive clipboard writes (password managers) are still excluded, and
    re-copying an entry from the widget doesn't create a duplicate row.

**Files changed:** `main/clipboard.js`, `renderer/clipboard.js`,
`renderer/core.js`, `main.js`, `package.json`, `CHANGELOG.md`

---

## [3.22.3] — 2026-07-15

### Fixed

- **Pasted app paths wrapped in quotes now work.** Windows Explorer's
  "Copy as path" wraps the path in double quotes (e.g.
  `"C:\Users\you\app.exe"`), which previously failed with "File not found"
  when pasted into a quick-launch app's path field. Surrounding quotes
  (double or single) and stray whitespace are now stripped automatically
  when the path is entered, and also at launch time so entries saved with
  quotes before this fix keep working.

**Files changed:** `renderer/widgets-settings.js`, `main/appLauncher.js`,
`main.js`, `package.json`, `CHANGELOG.md`

---

## [3.22.2] — 2026-07-14

Follow-up debugging pass after the v3.22.1 crash fix.

### Fixed

- **The music Visualizer had the same crash-prone loopback capture as Beat Glow,
  and it was still unguarded.** `updateVisualizerActiveState()` runs on every
  Spotify poll, and while capture was failed/null it re-opened the loopback
  `getDisplayMedia` audio stream every time — the exact audio-service thrashing
  that precedes the STATUS_STACK_BUFFER_OVERRUN renderer crash. Fixing Beat Glow
  alone (v3.22.1) left this second path open. The Visualizer now uses the same
  `vizAudioUnsupported` session latch (plus an `onstatechange` handler for
  mid-stream device errors, which it previously lacked), so a failed/erroring
  capture falls back to synthetic motion instead of being retried. This completes
  the v3.22.1 crash fix.
- **Spotify polling could revive itself after being stopped.**
  `startSpotifyPolling()` scheduled its first poll on a 200 ms `setTimeout` whose
  handle wasn't tracked, so `stopSpotifyPolling()` couldn't cancel it. A
  disconnect within that window left the timer pending, and it recreated the poll
  interval right after the stop — reconnecting/polling against a disconnected
  account. The handle is now tracked and cleared on stop, matching the existing
  retry-timer handling.

### Files changed

- `renderer/visualizer.js` — added the `vizAudioUnsupported` latch and an
  `onstatechange` teardown so a failed/erroring loopback capture stops being
  re-opened (mirrors `renderer/beat-glow.js`).
- `renderer/spotify-widget.js` — track the initial-poll `setTimeout` in
  `spotifyInitialPollTimeout` and clear it in `stopSpotifyPolling()`.
- `main.js`, `package.json` — version → v3.22.2.

---

## [3.22.1] — 2026-07-14

### Fixed

- **The Windows "System Error — stack-based buffer overrun" dialog on this
  machine.** Root cause was two separate problems stacked on top of each other:
  1. **The renderer intermittently crashes with STATUS_STACK_BUFFER_OVERRUN
     (0xC0000409), and the crash was not being suppressed.** The suppression
     depends on Electron's Crashpad handler (`chrome_crashpad_handler.exe`) and
     its WER runtime-exception module (`chrome_wer.dll`). This machine's Electron
     dist is missing both binaries, so `crashReporter.start()` had nothing to
     hand the crash to and Windows Error Reporting showed its modal dialog. A new
     `verifyCrashHandler()` check now logs a clear, actionable error at startup
     when those binaries are absent (reinstall/repair Electron, or check
     antivirus quarantine — crashpad handlers are a known false positive),
     instead of failing silently.
  2. **The crash itself was being triggered by the Beat Glow live-audio
     capture.** The logs show the audio device / WebAudio renderer repeatedly
     erroring ("The AudioContext encountered an error…") right before each crash.
     The loopback capture was re-opened on every track change even after it had
     errored, thrashing the audio service until the renderer went down. Beat Glow
     now **latches to the ambient pulse for the rest of the session** the first
     time loopback capture fails or errors, so it stops re-spinning the
     crash-prone capture. Restarting the app retries live capture as before.
- **Crashpad database now lives with the rest of the app's data.**
  `crashReporter.start()` was running before `userData` was pointed at
  `%APPDATA%/main-launcher`, so Crashpad initialised against Electron's default
  path and orphaned its database under `%APPDATA%/main-app`. `userData` is now
  set first, so crash data lands in the app's own folder.

### Files changed

- `main.js` — set `userData` before `crashReporter.start()`; added
  `verifyCrashHandler()` startup integrity check; `APP_VERSION` → v3.22.1.
- `renderer/beat-glow.js` — added the `liveAudioUnsupported` session latch so a
  failed/erroring loopback capture falls back to the ambient pulse permanently
  for the session instead of being retried on every track change.
- `package.json` — version → 3.22.1.

---

## [3.22.0] — 2026-07-10

### Added

- **Crosshair mini widget** (Crosshair X-style). Draws a customizable crosshair
  dead-center on the primary display, above every window — click-through and
  unfocusable, so it never steals input from the game underneath.
  - **Styles:** Cross, T, X, Circle, Dot.
  - **Options:** color (6 presets + custom picker), size, gap, thickness,
    opacity, optional black outline, optional independent center dot with its
    own size.
  - **Live preview** in Settings on a game-like backdrop — rendered by the same
    shared draw code as the overlay, so the preview is pixel-exact.
  - **Global show/hide hotkey** (default `Ctrl+Shift+X`), rebindable in Settings
    like every other hotkey; works while a game has focus, and the Settings
    toggle stays in sync when used.
  - The overlay recenters itself automatically when the display resolution
    changes (including via the Screen Resolution widget) or monitors are
    added/removed.
  - Like all overlay apps: visible over windowed/borderless games; true
    exclusive-fullscreen games draw over it (the panel explains this).

### Fixed

- **Beat Glow recovers when the audio device errors mid-capture.** If the
  WebAudio renderer/audio device fails while live capture is running (seen as
  "The AudioContext encountered an error" in the new renderer-error log), the
  glow now falls back to the ambient pulse instead of silently freezing in a
  dead 'live' mode.
- Renderer console-error capture (added in 3.21.1) now uses Electron's
  event-object form, silencing a deprecation warning on Electron 42.

### Files changed

- `main/crosshair.js` *(new)* — overlay window (transparent/click-through/
  always-on-top), `crosshair-apply` + `register-crosshair-hotkey` IPC, display
  recentering, hotkey toggle.
- `crosshair-overlay.html`, `crosshair-overlay-preload.js` *(new)* — the
  overlay page; paints via the shared renderer at devicePixelRatio.
- `renderer/crosshair-draw.js` *(new)* — shared pure canvas draw code used by
  both the overlay and the Settings preview.
- `renderer/crosshair.js` *(new)* — Settings panel (preview, style/color/
  sliders/toggles), config persistence, visibility sync.
- `renderer/core.js` — `crosshair` MINI_WIDGETS entry + default hotkey.
- `renderer/hotkeys.js` — crosshair in hotkey displays, `sendCrosshairHotkeyToMain`.
- `renderer/spotify-widget.js` — crosshair category in the rebind-conflict sync.
- `renderer/widgets-settings.js` — panel render + enable hook.
- `preload.js` — `crosshairApply`, `registerCrosshairHotkey`,
  `onCrosshairVisibilityChanged` bridges.
- `main.js` — module init, hotkey reapply on enable-all, teardown on quit.
- `renderer/beat-glow.js` — AudioContext state-change fallback.
- `logger.js` — console-message handler modernized.
- `main.html` — script tags; `package.json` — overlay files added to the build
  list; version → 3.22.0.

---

## [3.21.1] — 2026-07-10

Debugging pass: no new features, just fixes and cleanup.

### Fixed

- **Beat Glow no longer probes Spotify's retired beat-data API.** Every session
  fired two doomed requests at `/audio-analysis` + `/audio-features` (retired by
  Spotify, always HTTP 403) before falling back to live audio — guaranteed error
  spam in `errors.log` on every launch. The probe, its IPC handlers and caches
  are gone; Beat Glow goes straight to the live PC-audio listener.
- **Video Editor: orphaned preview audio could play forever.** The per-track
  preview stems are detached `<audio>` objects, so anything that rebuilt the
  panel mid-playback (opening Settings again, toggling any mini-widget) silenced
  the video but left the stems playing with no way to stop them. The panel now
  pauses stems on every rebuild and tears them down when the widget is disabled.
- **Video Editor: preview kept sounding after Settings closed.** Closing the
  Settings window now pauses the preview (video + stems) instead of letting it
  play on invisibly inside the hidden modal.
- **Removed a booby-trapped `web-contents-created` handler** in `main.js` that
  tried to close every non-main window. It has always been a silent no-op
  (`BrowserWindow.fromWebContents` returns null while that event fires), but if
  Electron ever changed that timing it would have instantly closed the Spotify
  auth window and the mic-mute overlay.
- **Deleted four stray zero-byte files** from the app folder (`` ` ``, `{`,
  `localStorage.setItem('main-notes'`, `notif.remove()`) — leftover shell
  artifacts from an earlier session.

### Changed

- **DEBUG logging is now opt-in** (`LAUNCHER_DEBUG=1`). The Spotify poll wrote
  ~8 DEBUG lines to `main.log` every 2.5 s — constant disk churn that rotated
  away real errors. INFO/WARN/ERROR/SUCCESS logging is unchanged, and the
  startup banner says how to turn DEBUG back on.
- **Renderer console errors are now recorded** in the main log (they previously
  vanished unless DevTools was open) — no more silent renderer failures.
- **`open-external` only accepts http/https URLs** — a file:// or
  custom-protocol URL handed to the OS shell could launch arbitrary programs.
- **Single Settings close path.** `closeSettings()` (widgets-settings.js) was a
  near-duplicate of `closeSettingsDone()` minus the hotkey-bind cancel; the
  duplicate is gone and the Escape shortcut now uses the full version.

### Files changed

- `renderer/beat-glow.js` — dead-API probe removed from `loadBeatDataForTrack`.
- `main/spotify.js` — `spotify-get-audio-analysis` / `spotify-get-audio-features`
  handlers and their caches removed.
- `preload.js` — the two matching bridge entries removed.
- `renderer/video-editor.js` — stems paused on panel rebuild; `vePausePreview()`.
- `renderer/settings.js` — `closeSettingsDone()` pauses the preview.
- `renderer/widgets-settings.js` — duplicate `closeSettings()` removed.
- `renderer/spotify-widget.js` — Escape path now calls `closeSettingsDone()`.
- `logger.js` — opt-in `debug()`, renderer `console-message` error capture.
- `main.js` — `web-contents-created` handler removed; `open-external` validation.
- `renderer/core.js`, `main.html`, `package.json` — version → 3.21.1.

---

## [3.21.0] — 2026-07-10

### Added

- **Preview now reflects per-track audio edits.** Muting a track or changing its
  volume on the timeline is heard live in the preview, not just on export. For
  clips with a single audio track this drives the video's own volume/mute; for
  multi-track clips each track is extracted to a cached audio stem and the enabled
  ones are mixed together, kept in sync with the (muted) video. (Preview volume
  caps at 100% — a boost above that still applies to the exported file.)

### Changed

- **Escape now exits the Settings search box** (clears the filter and drops focus)
  instead of closing the whole Settings window when the search field is focused.

### Files changed

- `main/videoEditor.js` — `video-audio-stems` handler that extracts each audio
  track to a cached AAC stem for the preview mixer.
- `preload.js` — `videoAudioStems` passthrough.
- `renderer/video-editor.js` — preview audio mixer (native single-track path +
  hidden-`<audio>` stem mix for multi-track), synced to the video's play/pause/
  seek/rate/drift; live updates from the lane checkbox & volume slider.
- `renderer/spotify-widget.js` — Escape exits the search box before the
  close-window shortcut runs.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.21.0.

---

## [3.20.0] — 2026-07-10

### Added

- **Per-track audio controls on the timeline (Vegas-style):** each audio lane now
  carries an **include checkbox** in its top-left corner and a **volume slider**
  in the middle. All tracks are **ticked and exported by default** — untick one to
  grey the lane out and drop it from the export; drag a slider (0–150%) to set that
  track's volume. Every ticked track is muxed into the output as its own stream.
- **Multi-track export:** exports now keep *all* enabled audio tracks (previously
  a single track was chosen). When every kept track is at 100% the audio is still
  stream-copied losslessly; a track at any other volume is re-encoded to AAC with
  a per-stream `volume` filter (other tracks stay untouched where possible).

### Fixed

- **Keystrokes no longer leak into the Settings search box while editing video.**
  The "type to search" shortcut is now suspended whenever the Video Editor preview
  is on screen, so Space / letters drive playback instead of landing in the search
  field.

### Files changed

- `main/videoEditor.js` — `buildArgs`/export now take an `audioSelections` list
  (per-track index + volume): maps every kept track, stream-copies at 100% or
  re-encodes to AAC with per-stream `volume` filters otherwise.
- `renderer/video-editor.js` — per-track `enabled`/`volume` state; lane checkbox
  + volume slider; `veToggleTrack`/`veSetTrackVolume`; shared `veIsPreviewOnScreen`
  helper; lane-control click guard; settings audio section reworked to a summary.
- `renderer/spotify-widget.js` — type-to-search suppressed while the video preview
  is visible.
- `styles/main.css` — lane checkbox, disabled (greyed) lane, and volume-slider
  styles.
- `renderer/core.js`, `main.html`, `package.json`, `main.js` — version → 3.20.0.

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
