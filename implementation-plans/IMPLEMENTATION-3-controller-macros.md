# IMPLEMENTATION — Controller Button Macros Mini Widget

> **How to use this file:** Paste this entire document into Claude Code. This is a complete implementation specification for a new "Controller Macros" mini widget. It is split into **six stages** — implement them in order; each stage must leave the app fully working.

---

# Goal

Add a new mini widget, **Controller Macros**, that lets the user build and replay macros made of **gamepad button presses** (Cross ✕, Square □, Triangle △, Circle ○, L1/L2, R1/R2, D-Pad, Start/Select, sticks-click) that **games genuinely receive as controller input** — as if a real PlayStation or Xbox pad pressed them.

This mirrors the existing keyboard/mouse **Macros** widget (`main/macros.js`) in look, feel, and behaviour:

- Per-macro keyboard hotkeys with **Pressed / Hold / Toggle / Released** trigger modes
- **Repeat counts** and **playback speed**
- The same list-style config panel hosted in the Widget Library detail view
- The same storage, logging, and helper-process patterns

The only conceptual difference: instead of replaying mouse/keyboard events via `SendInput`, playback presses buttons on a **virtual controller device** so games see a real gamepad.

## How virtual controller input works (context)

Windows games only see gamepads that exist as actual devices. The standard way to create one is the free, open-source **ViGEmBus kernel driver** (Nefarius/ViGEmBus — the same driver DS4Windows uses). Once installed, a client can plug in a virtual **Xbox 360** pad (XInput — best game compatibility) or a virtual **DualShock 4** pad (games show ✕/□/△/○ prompts). The user chose: **let me switch** — the widget must offer both, defaulting to Xbox 360 for compatibility, while the widget UI always shows PlayStation button labels (with the Xbox equivalent as secondary text).

**Driver requirement is a first-class UX concern:** the widget must detect whether ViGEmBus is installed, and when it isn't, show a friendly banner in the panel with a one-click "Get the driver" button (opens the official download page in the browser) plus a "Re-check" button. Never silently fail — everything through the Logger.

---

# Deliverables

✓ New `Controller Macros` entry in the `MINI_WIDGETS` registry (one entry, per CLAUDE.md rules)

✓ Virtual controller engine (helper process) that plugs a virtual DS4 or Xbox 360 pad via ViGEmBus

✓ ViGEmBus driver detection + guided install UX

✓ Macro editor: build sequences of button steps (tap, hold for N ms, wait N ms), including analog full-press for L2/R2

✓ Optional macro **recording from a physical controller** (Gamepad API in the renderer) when one is connected

✓ Per-macro hotkeys with Pressed / Hold / Toggle / Released, repeat counts, playback speed — identical semantics to the existing Macros widget

✓ PlayStation ↔ Xbox emulation switch in the panel

✓ Persistent storage in `%APPDATA%/main-launcher/controllerMacros.json`

✓ Version bump, changelog, modified-file list (in the final stage)

---

# Constraints (Non-Negotiable)

- The existing keyboard/mouse Macros widget must keep working exactly as before.
- Follow the established helper-process pattern: a PowerShell-launched compiled C# background process managed via `ensureVersionedScript` (`main/scriptCache.js`), talking over a stdin/stdout line protocol — exactly like `main/macros.js`.
- One registry entry in `MINI_WIDGETS`; the Library card, search, dashboard strip, and Settings summary must all come from the registry. No hardcoded widget lists.
- Config panel renderer must no-op when its panel div is absent (`if (!panel) return;`).
- All errors through the Logger. No silent failures.
- New Tailwind classes require `npm run build:css` and committing the regenerated `styles/vendor/tailwind.css`.
- Glassmorphism styling consistent with the rest of the app; no layout jumps.
- Storage keys stable; never break `%APPDATA%/main-launcher` compatibility.
- **Anti-cheat warning:** some competitive games (e.g. Valorant/Vanguard) may block or dislike virtual controller drivers and synthetic input. Show a short, honest note in the widget's detail panel; do not attempt any evasion.

---

# Stage 1 — Virtual Controller Engine (foundation)

**Goal:** a background helper process that can plug/unplug a virtual pad and press buttons on it, plus reliable driver detection. No UI yet.

1. **Driver detection** in a new `main/controllerMacros.js`: check for ViGEmBus (service `HKLM\SYSTEM\CurrentControlSet\Services\ViGEmBus` and/or `Get-Service ViGEmBus`) via a quick PowerShell probe. Expose result over IPC later.
2. **ViGEm client library:** vendor the .NET Framework build of **`Nefarius.ViGEm.Client`** (BSD-3 licensed) as a DLL under `main/vendor/` and load it from the helper via `Add-Type -Path` / `-ReferencedAssemblies`. **Verify early** that the DLL loads under Windows PowerShell 5.1 (.NET Framework 4.x). If the available NuGet builds are netstandard-only and won't load, fall back to compiling the client's C# sources (it's a small, single-purpose library) directly into the helper script — decide in this stage, before anything is built on top.
3. **Engine helper script** (`ensureVersionedScript`, versioned like `MACRO_ENGINE_SCRIPT_VERSION`): a persistent process with a line protocol modeled on the macro engine:
   - `PLUG DS4` / `PLUG X360` — create + connect the virtual pad (re-plug if type changes)
   - `UNPLUG` — disconnect
   - `SEQ <count> <speed> <file>` — play a sequence file `<count>` times (0 = forever) at `<speed>` multiplier; emits `SEQ-DONE` / `SEQ-STOPPED`
   - `STOP`, `PING`/`PONG`, `READY`, `EXIT` — same lifecycle semantics as the macro engine
   - Sequence file lines: `t kind btn val` (ms offset, kind: 0 button-down, 1 button-up, 2 trigger-value 0–255 for L2/R2)
4. **Button map:** one canonical internal button id set (`cross, square, triangle, circle, l1, r1, l2, r2, l3, r3, dpadUp/Down/Left/Right, options, share, guide`) mapped to both DS4 and X360 report fields inside the engine, so sequences are layout-agnostic.
5. **Lifecycle:** spawn on demand (first playback or panel open with widget enabled), `EXIT` + unplug on app quit, watchdog restart on crash (log it). Mirror `macros.js` process management.
6. **Smoke test:** a temporary dev-only IPC (removed in Stage 6) or test script that plugs an X360 pad and taps A — verify in Windows "Game Controllers" (`joy.cpl`) / a gamepad tester page that the press registers.

**Exit criteria:** with ViGEmBus installed, a scripted sequence visibly presses buttons on a virtual pad; without the driver, detection reports "missing" cleanly and nothing crashes.

---

# Stage 2 — Backend Module & Storage

**Goal:** complete `main/controllerMacros.js` backend with storage and IPC, no UI yet.

1. **Storage:** `%APPDATA%/main-launcher/controllerMacros.json`:
   ```json
   {
     "padType": "x360",
     "macros": [
       {
         "id": "uuid",
         "name": "Combo 1",
         "steps": [ { "btn": "l2", "action": "hold", "ms": 500 }, { "btn": "square", "action": "tap" }, { "wait": 200 }, { "btn": "cross", "action": "tap" } ],
         "hotkey": "F6",
         "trigger": "pressed",
         "repeat": 1,
         "speed": 1.0,
         "enabled": true
       }
     ]
   }
   ```
   Load defensively (corrupt file → log + start fresh, never crash). Steps are compiled to engine sequence files at play time (tap = down + 60 ms + up; triggers emit analog kind).
2. **IPC handlers** (registered like the other `main/*.js` modules, exposed in `preload.js` under a `controllerMacros` namespace): `list`, `save`, `delete`, `play`, `stop`, `setPadType`, `driverStatus`, `openDriverPage` (shell.openExternal to the official ViGEmBus releases page).
3. **Playback semantics:** identical to the Macros widget — repeat count (0 = until stopped), speed multiplier scales the time offsets, one active playback at a time per widget (starting a new macro stops the previous; log it).
4. **Widget enable/disable hook:** when the widget is disabled in the Library, unregister its hotkeys, stop playback, unplug the pad, and stop the engine.

**Exit criteria:** macros can be created/played/stopped entirely over IPC from DevTools; state survives app restart.

---

# Stage 3 — Registry Entry & Panel Shell

**Goal:** the widget exists in the Widget Library with a working (but editor-less) panel.

1. **One `MINI_WIDGETS` entry** in `renderer/core.js`:
   - `id: 'controllerMacros'`, `label: 'Controller Macros'`, icon `fa-gamepad`
   - `description` / `longDescription` explaining virtual controller presses + driver requirement + the anti-cheat note
   - `category`: reuse the most fitting existing category (same one as Macros if no gaming category exists — do **not** invent parallel category systems; if adding a category, add it properly to `MINI_WIDGET_CATEGORIES`)
   - `keywords`: `['controller', 'gamepad', 'playstation', 'ps4', 'ps5', 'dualshock', 'xbox', 'macro', 'combo', 'vigem', 'button']`
   - `version: '1.0.0'`, `author: 'ryota'`, `features` list
   - `panelId: 'controller-macros-panel'`, `panelRenderer: 'renderControllerMacrosPanel'`
2. **New renderer file** `renderer/controller-macros.js` (loaded from `main.html` like the other renderer modules) exporting the global `renderControllerMacrosPanel`. It must no-op when the panel div is absent.
3. **Panel shell contents:**
   - **Driver status banner:** green "ViGEmBus installed" / amber "Driver required" with *Get the driver* + *Re-check* buttons
   - **Pad type switch:** PlayStation (DualShock 4) ↔ Xbox 360 segmented control; persists via `setPadType`; re-plugs the virtual pad live
   - **Macro list:** name, hotkey badge, trigger mode, enable toggle, ▶ test-play / ■ stop, edit, delete — same visual language as the Macros panel
   - Empty state with a short "how it works" line
4. Glassmorphism styling consistent with the existing Macros panel; run `npm run build:css` if any new Tailwind classes are used.

**Exit criteria:** widget appears in the Library (searchable, favouritable, enable/disable persists), panel shows real driver status and a live macro list backed by Stage 2 IPC.

---

# Stage 4 — Macro Editor (+ optional recording)

**Goal:** users can build and edit button sequences comfortably.

1. **Step editor** inside the panel's edit view: an ordered list of steps, each either
   - **Button step:** button picker + action (*Tap* / *Hold … ms*), or
   - **Wait step:** delay in ms
   with add / remove / reorder (up-down buttons are fine; drag optional) and inline validation (ms bounds, at least one step).
2. **Button picker:** grid of buttons showing **PlayStation glyphs/labels primary** (✕ □ △ ○ L1 L2 R1 R2 L3 R3 D-Pad, Options, Share) with the Xbox equivalent as small secondary text (A X Y B LB LT RB RT …). The picker is layout-agnostic — the canonical button id is stored, the pad-type switch only changes what games see.
3. **Live test:** a *Test* button in the editor plays the current (unsaved) sequence through the virtual pad.
4. **Record from a physical controller (optional path, same editor):** if `navigator.getGamepads()` shows a connected pad, show a **Record** button — while recording, poll the Gamepad API (~120 Hz), capture button down/up and trigger values with timestamps, and convert to steps on stop. Hidden/disabled with a tooltip when no physical pad is connected. This mirrors the record-then-replay feel of the original Macros widget without requiring a pad.
5. Save writes through Stage 2 `save` IPC; list refreshes; no flicker.

**Exit criteria:** a user can build "hold L2 500 ms → tap Square → wait 200 ms → tap Cross", test it live, save it, and see it in the list; with a physical pad connected, the same combo can be recorded instead of built by hand.

---

# Stage 5 — Triggers: Hotkeys with Full Parity

**Goal:** per-macro hotkeys behave exactly like the keyboard/mouse Macros widget.

1. **Hotkey capture UI** in the editor — same interaction as the existing Macros panel's bind flow.
2. **Trigger modes** with identical semantics:
   - **Pressed** — fires the macro once per key press
   - **Hold** — plays while the key is held, stops on release
   - **Toggle** — press starts (respecting repeat count / forever), press again stops
   - **Released** — fires when the key is released
   Hold/Released need key-release visibility, which Electron's `globalShortcut` cannot provide. **Reuse the existing macro engine's `WATCH` infrastructure** — refactor `main/macros.js` to export a small subscription API (watch these VKs, callback on KEY-DOWN/KEY-UP) rather than spawning a second key-watching process. This refactor must not change the Macros widget's behaviour.
3. **Repeat count & speed** controls in the editor (same ranges/labels as the Macros widget).
4. **Conflict handling:** warn (non-blocking, consistent with existing behaviour) when a chosen hotkey collides with another controller macro, a keyboard/mouse macro, or a global app hotkey.
5. Hotkeys register only while the widget is enabled; clean unregister on disable/quit.

**Exit criteria:** all four trigger modes verified working system-wide (fired from another focused window), repeat/speed respected, no interference with the existing Macros widget's hotkeys.

---

# Stage 6 — Polish, Edge Cases, Docs & Release

**Goal:** production-ready, per CLAUDE.md.

1. **Edge cases:**
   - Driver uninstalled while running → playback fails gracefully, banner flips to "Driver required", Logger entry
   - Engine crash mid-playback → watchdog restarts, buttons are released (unplug/re-plug guarantees no stuck inputs)
   - App quit / widget disable mid-hold → all buttons released and pad unplugged before exit
   - Corrupt storage JSON → logged, fresh start, no crash
   - Playing a macro while another is playing → previous stops (matches decision in Stage 2)
2. **Remove** any dev-only smoke-test IPC from Stage 1.
3. **Anti-cheat note** finalized in `longDescription` and as a subtle line in the panel.
4. **Verification pass (CDP)** per project practice: open the Library, search "controller", open the detail, exercise the panel; verify a full end-to-end press lands in `joy.cpl`/a gamepad tester with both DS4 and X360 modes; regression-check the keyboard/mouse Macros widget (record + all four trigger modes) after the Stage 5 refactor.
5. **Release bookkeeping:** minor version bump (new feature) in `package.json` + `APP_VERSION` in `renderer/core.js`, `CHANGELOG.md` entry, list of modified files, `npm run build:css` output committed if Tailwind classes were added.

**Exit criteria:** everything in Deliverables is done, no regressions, changelog + version updated.

---

# Files Expected to Change

| File | Change |
| --- | --- |
| `main/controllerMacros.js` | **new** — driver detection, engine process, storage, IPC, hotkeys |
| `main/vendor/…ViGEm client DLL…` | **new** — vendored client library (or compiled-in sources; Stage 1 decision) |
| `main/macros.js` | small refactor — export shared key-watch (`WATCH`) subscription API |
| `preload.js` | expose `controllerMacros` IPC namespace |
| `renderer/core.js` | one `MINI_WIDGETS` entry; `APP_VERSION` bump |
| `renderer/controller-macros.js` | **new** — panel renderer, editor, recording |
| `main.html` | load the new renderer script; panel div lives in Library detail (generated) |
| `styles/main.css` / `styles/vendor/tailwind.css` | panel styling / rebuilt Tailwind if needed |
| `package.json`, `CHANGELOG.md` | version + changelog |
