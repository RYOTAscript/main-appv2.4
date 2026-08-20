# v4.0.0 — Full Debug & Scan Report

**Date:** 2026-08-20 · **App:** v4.0.0 (the macOS-support release) · **Host:** Windows 11 (26200)
**Protocol:** followed `DEBUG.md` (root-cause fixes, no regressions, small polish, per-fix format).
**Scope:** every part of all three apps — desktop app (`main-app`), ValClips, website — plus legal, animations, runtime, and the live site.

## Verdict

**v4.0.0 is production-ready and the cleanest release to date.** A full scan of
141 JS files, 45 main-process modules, 42 renderer files, both other apps, and
the live website turned up **one real bug** (a ValClips test that hard-failed
without an optional toolchain — fixed) and **two polish gaps** (fixed). No
leaks, no duplicate handlers, no unguarded crashes, no console errors, no
regressions. The runtime boot logs **zero errors**.

| Suite | Result |
|---|---|
| Desktop `npm test` | **157 / 157 pass** |
| ValClips `npm test` | **74 pass, 10 skipped, 0 fail** (was 1 fail) |
| Website `tsc --noEmit` | **clean (exit 0)** |
| Website `next lint` | 1 intentional warning (self-hosted Font Awesome `<link>`) |
| Syntax-check (all 141 `.js`) | **0 failures** |
| Live site (all routes) | **200**, no console errors |
| Current app boot | **0 errors / 0 warnings** |

---

## Bugs & improvements (DEBUG.md format)

### Bug #1 — ValClips e2e test hard-fails without the FFmpeg+VMAF toolchain
**Bug:** `valclips npm test` failed (`expected 'missing' to be 'ready'`) on any
machine that hasn't downloaded ValClips's optional FFmpeg+VMAF toolchain.
**Root cause:** `tests/e2e.test.ts` ran its `beforeAll` unconditionally and
hard-`expect`ed the toolchain to be `ready`, while its sibling
`tests/pipeline.integration.test.ts` guards with `describe.skipIf(...)`.
**Solution:** gate the e2e `describe` on a top-level `ensureToolchain()` check
(`describe.skipIf(!e2eToolchainReady)`), matching the sibling — so the suite
skips gracefully instead of failing when the (large, one-time-download) toolchain
isn't present.
**Verification:** `npm test` → 74 pass / 10 skipped / **0 fail** (was 1 fail).
**Regression check:** the 74 unit tests + the integration suite still run/skip
exactly as before; the fix only affects the e2e gate.

### Improvement #1 — mac widget toggles now match the app's polished switch
**What:** the 3 new mac **settings** panels (Dock Styler, macOS Tweaks, Macros
enable) rendered on/off toggles as plain browser checkboxes, while every other
widget uses the app's `.ios-toggle` sliding switch.
**Why:** visual consistency + the sliding animation the rest of the app has.
**Solution:** converted those toggles to the existing `.ios-toggle` markup (zero
CSS rebuild — the class already exists). **Selection** checkboxes (App Installer
grid, Free-Up app list, App Uninstaller leftovers, Macros modifiers) correctly
stay as checkboxes.
**Verification:** syntax-checked; 157/157 tests still pass.

### Improvement #2 — clearer Homebrew prompt + notices in sync
**What:** (a) the tool-install prompt now says the word **"Homebrew"** when it's
missing (it used to open Terminal with a generic "finish and retry"); (b) added a
`THIRD-PARTY-NOTICES.txt` section for the macOS on-demand tools (Homebrew/
blueutil/displayplacer/cliclick, all MIT/BSD, install-on-demand, not bundled),
per the legal-to-sell rule.
*(The prompt-wording change shipped in v4.0.0; the notices section is in this
debug commit.)*

---

## Areas scanned — all clean ✅

**Stability / correctness**
- **Duplicate IPC handlers:** the only cross-file duplicates are Windows-module ↔
  mac-module pairs (bluetooth, screen-resolution, game-mode, claude-limit), which
  init in mutually-exclusive `isWindows`/`isMac` blocks — no double-registration.
- **Renderer listener leaks:** all ~25 `electronAPI.on*` registrations are either
  guarded by a `*Hooked` flag or registered once at IIFE top level. None inside a
  re-rendered function unguarded.
- **Interval leaks:** every `setInterval` is one-time-init (app-lifetime) or
  stored + cleared with a teardown (`gameModeMac`, `claudeLimitMac`, etc. also
  clear on `will-quit`). `autoUpdate`'s uncleared one is the intentional 6-hour
  poll.
- **Global error handling:** `logger.js` has both `uncaughtException` and
  `unhandledRejection` handlers; `main.js` has `crashReporter.start()` +
  `render-process-gone` auto-recovery with a repeated-crash guard.
- **`JSON.parse` on persisted data:** all sites are guarded (directly or by the
  caller) — corrupt config can't crash the app.

**Legal (v4 sale)** — `THIRD-PARTY-NOTICES.txt` is thorough and correct:
- **FFmpeg (GPLv3)** — the one copyleft component; handled correctly: invoked as a
  separate process (no linking) + a GPLv3 §6 written source offer.
- Electron (MIT), Font Awesome **Free** (CC-BY-4.0/OFL/MIT), ViGEm DLL (BSD-3),
  electron-updater (MIT) — all permissive + credited.
- macOS on-demand tools — MIT/BSD, installed as the user's action, not bundled.
- Claude Limit **waits for the reset** (never bypasses a limit); debloat/
  uninstaller only touch the user's own machine, reversibly; app installers pull
  from official publishers.

**Animations** — already excellent, nothing to fix: 56 intentional `@keyframes`,
a **comprehensive global `prefers-reduced-motion`** rule plus targeted overrides,
`will-change` used sparingly (8 spots), and layout-property transitions limited to
progress bars (an acceptable pattern). GPU-friendly throughout. The website's
entrance animations were verified smooth in the browser.

**Runtime** — current boot logs **zero errors/warnings**; every widget initialized
successfully. v4.0.0 has **1 error total ever** (a transient Spotify `ECONNRESET`,
gracefully retried) vs 110 in v3.48.6 and 510 in v3.40.0. Historical errors are
all offline/network transients, not code bugs. No v4 regressions.

**Website** — all routes 200, real content, **no console errors**, clean `tsc`,
and the entrance animations render smoothly. v4.0.0 + "$5 lifetime" pill live.

---

## One item flagged for you (not auto-changed)

- **Bundled brand icons** (`icons/discord.ico`, `spotify.ico`, `chrome.ico`,
  `valorant.ico`, `siege.ico`) — third-party logos shipped as Quick-Launch tile
  icons. This is common functional/nominative use, but it's the one licensing
  gray area. Left as-is (removing breaks default icons) — your call.
- **Website copy still says "for Windows" / "Windows 10/11."** This is *correct
  right now* — advertising macOS before the `.dmg` is downloadable would mislead.
  Update it (and set `DOWNLOAD_URL_MAC`) once you build + publish the mac release;
  the two-button download page is already wired and the Mac button auto-appears.

---

## Needs a Mac (can't verify from Windows)

The mac runtime behavior is still only unit-tested. Follow **`MAC_TEST_BRIEF.md`**
on-device to confirm the osascript/`defaults`/`blueutil`/`displayplacer`/`cliclick`
paths, the new `.ios-toggle` mac panels, and the license machine-binding.

## Deploy status

v4.0.0 (Windows) is **live** (shipped earlier via `/de`). The improvements in
this debug pass (ValClips test, mac-panel toggles, notices, CLAUDE.md) are
**committed to git but not re-deployed** — none of them change what a live
**Windows** user sees (mac panels aren't visible on Windows; the test fix is
test-only; the notices addendum covers non-bundled tools). They'll be in the next
build. Re-run `/de` if you want to cut a v4.0.1 anyway.
