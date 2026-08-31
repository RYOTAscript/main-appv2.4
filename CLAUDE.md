# CLAUDE.md

Guidance for Claude Code when working in this repository. This file auto-loads
at the repo root. Keep it accurate — when you change how something is built,
run, or wired, update this file in the same change.

---

## 1. What this repo is

A **monorepo with three independent apps** that ship one product ("**main**", a
Windows gaming/productivity launcher):

| App | Path | Stack | Purpose |
|-----|------|-------|---------|
| **Desktop app (Main)** | `main-appv2.4-main/main-app11/main-app/` | Electron 42, CommonJS, vanilla JS + vendored Tailwind | The always-on desktop overlay. The product itself. |
| **ValClips Quality** | `main-appv2.4-main/valclips-quality/` | electron-vite, React 19, TypeScript, Vitest | Standalone TikTok/Valorant clip quality tool, launched from Main. |
| **Website (main-website)** | `website/` | Next.js 14 (App Router), Prisma + Postgres, NextAuth, PayPal | Marketing + commerce site: sells licenses, provisions keys. |

FPS optimization used to live in a nested helper Electron app
(`fps-optimizer-electron/`); that app is **gone**. It is now a first-class
feature module, `main/fpsOptimizer.js` — an in-process `tasklist`/`taskkill`
sweep with a hard self-protection whitelist (never kills the launcher, its child
windows, or system processes). Don't reintroduce a separate FPS app.

The desktop app and website share a version number (currently **4.0.0** — the
release that introduced macOS support); ValClips versions independently (**1.2.0**).

---

## 2. Desktop app (Main) — the primary codebase

Always-on Electron overlay for gamers/power users. Glass-morphism UI, tray/menu-bar
background operation. **Windows and macOS are both supported** (see
`MACOS_PORT_REPORT.md`). Branch OS-specific work on `main/platform.js`
(`isWindows`/`isMac`): Windows → `shellUtils`/PowerShell, macOS → `osascript`
(+ `defaults`/`runFile`, or a free Homebrew CLI via `main/macTools.js`).

**Registry: 33 widget entries.** Windows shows 27, macOS shows 24. Three kinds:
- **Cross-platform** (no `platforms` field): most widgets, incl. some with a
  different backend per OS — bluetooth (WinRT ↔ `blueutil`), screenResolution
  (↔ `displayplacer`), claudeLimit (SendKeys ↔ osascript; the `~/.claude` reader
  is shared), gameMode (Win32 watcher ↔ osascript poll). A `main/<feat>Mac.js`
  registers the SAME IPC channels on mac; the Windows module is init-skipped there.
- **`platforms: ['win32']`** — Windows-only. Three have NO mac equivalent:
  **controllerMacros** (a virtual gamepad needs a DriverKit kext),
  **autoClicker** (SendInput + GDI screen capture; macOS needs a signed
  Accessibility/Screen-Recording path) and **voiceAssistant** (offline
  grammar recognition via .NET `System.Speech`; macOS exposes no equivalent
  command recognizer through osascript). Six have a **mac
  substitute** shipped as a separate darwin-only widget: taskbar→**dockStyler**,
  debloat→**macTweaks**, revoUninstaller→**appUninstaller**,
  appInstaller→**appInstallerMac** (Homebrew), fpsOptimizer→**macFreeUp**,
  macros→**macMacros** (build-and-play via osascript/`cliclick`, no recording).
- **`platforms: ['darwin']`** — the 6 mac-only substitute widgets above.

Windows-only `main/` modules are still skipped at init on non-Windows; the mac
modules run in a parallel `if (isMac)` init block (see main.js). Tools that need a
Homebrew CLI (blueutil/displayplacer/casks) return `{ needsTool }`; the shared
`renderer/mac-tools.js` renders a legal **1-click install** (official brew.sh
installer, MIT tools, install-on-demand — see [[legal-to-sell-rule]]).

### Entry points & process model
- **Main process:** `main.js` (~800 lines) — window/tray/IPC setup, then it
  requires ~31 feature modules from `main/`. Feature logic lives in `main/*.js`
  modules, roughly one per feature (`spotify.js`, `fileSearch.js`,
  `controllerMacros.js`, `fpsOptimizer.js`, `debloat.js`, …). Alongside the
  feature modules sit **shared infrastructure modules** that most features
  build on — treat these as the low-level toolkit, not features:
  `shellUtils.js` (`runCmd`/`runCmdSync`, ~13 requirers), `scriptCache.js`
  (`ensureVersionedScript`, ~11 requirers), `httpClient.js` (`safeFetch` — a
  fetch-shaped wrapper over Node `https`), `boundedCache.js` (LRU-ish cache),
  `elevate.js` (relaunches the *whole app* under UAC for admin-gated work),
  `voiceHostScript.js` (the speech host's C#, kept out of its module for size),
  `platform.js` (`isWindows`/`isMac`/`isLinux` + `pick()` — OS branching, from
  the macOS port), `windowGuard.js` (`lockNavigation` — denies `window.open` and
  in-window navigation; **every** BrowserWindow must go through it, except the
  Spotify auth window, which has to navigate and keeps its own handlers) and
  `osascript.js` (`runAppleScript` + shared AppleScript
  builders — the mac counterpart to `shellUtils`). When a feature needs OS work,
  branch on `platform.js` and route Windows through `shellUtils`/PowerShell,
  macOS through `osascript`.
- **Preload:** `preload.js` (~320 lines) — the **only** bridge. Exposes
  `window.electronAPI` via `contextBridge`. Context isolation is on; the
  renderer has no direct Node access. Add a method here to expose new
  main-process capability.
- **Renderer:** `main.html` + `renderer/core.js` (bootstrap, ~470 lines, holds
  the `MINI_WIDGETS` registry) + one `renderer/<feature>.js` per feature (~41
  files). Vanilla JS, no framework.
- **Child windows:** besides the main overlay, Main spawns dedicated
  frameless/transparent windows — e.g. the crosshair overlay
  (`main/crosshair.js`), the mic-mute overlay (`main/micMute.js`), and the
  license gate. FPS-optimizer kill sweeps protect all of them by PID + image
  name so they can never self-terminate.

### IPC pattern (follow it exactly)
Renderer → `window.electronAPI.someCall()` (in `preload.js`) →
`ipcRenderer.invoke('channel', …)` → `ipcMain.handle('channel', …)` in the
feature's `main/*.js`. ~30 main modules register handlers (~190 channels total).
Never reach around the preload bridge; never enable `nodeIntegration` in the
renderer.

### Mini-Widget registry — single source of truth
`MINI_WIDGETS` in **`renderer/core.js`** is the one registry for all Launcher
mini widgets. To add a widget:
1. Add **one** registry entry (id, label, icon, description, longDescription,
   category, keywords, version, author, features, optional `defaultHotkey`,
   optional `panelId` + `panelRenderer`, optional `platforms`). The full field
   reference is the comment block directly above `MINI_WIDGETS_ALL`.
2. Add the widget's own `renderer/<id>.js` and, if it needs OS/privileged work,
   `main/<id>.js` + a `preload.js` method.
3. Add any Tailwind classes → **rebuild CSS** (see gotchas).

The registry holds **33 widget entries** across 12 categories (Audio, Clipboard,
Displays, Gaming, Media, Productivity, Searching, Social, Spotify, System,
Utilities, Weather); the Widget Library shows the OS-filtered subset — **27 on
Windows, 24 on macOS**. The Widget Library, its search index, the dashboard Mini
Widgets strip, and the Settings summary **all generate from this registry** —
never hardcode widget lists in UI code.

**Platform gating (macOS port):** the full catalogue is `MINI_WIDGETS_ALL`; the
app derives `MINI_WIDGETS` from it by filtering to the current OS via
`renderer/widget-platform.js` (loaded before `core.js`; uses
`window.electronAPI.platform`). A widget with no `platforms` field runs
everywhere. `platforms: ['win32']` marks Windows-only widgets — `macros`,
`controllerMacros`, `autoClicker` and `voiceAssistant` (no mac equivalent) plus
`taskbar`, `debloat`, `revoUninstaller`, `appInstaller`, `fpsOptimizer` (each has a
separate `platforms: ['darwin']` substitute widget). See §2's registry note for the full
mapping. On Windows the filter keeps all 27 Windows widgets and defaults to
`win32` when the platform can't be read, so behaviour there is unchanged. Every
consumer reads the filtered `MINI_WIDGETS`, so gating one entry hides it
everywhere at once.

Config panels (`panelId`) render inside the library detail
view and must no-op when their div is absent (`if (!panel) return;`) — the div
only exists while the detail is open. Enabled state → `miniWidgetPrefs`,
favourites → `miniWidgetFavs`, recents → `miniWidgetRecents` (all localStorage;
keep keys stable).

### Commands (run from `main-appv2.4-main/main-app11/main-app/`)
```bash
npm start            # electron . — run the app in dev
npm run build:css    # REQUIRED after adding/removing any Tailwind class
npm run build        # electron-builder --win --publish never → NSIS + portable
npm run build:mac    # electron-builder --mac → dmg + zip (arm64 + x64). MAC ONLY.
npm run build:mac:dir #  unsigned .app for a quick local smoke test. MAC ONLY.
```
**macOS builds must run on a Mac** (dmg creation + code-signing + notarization
are mac-only) — electron-builder refuses `--mac` on Windows. The `mac` target
ships a **dmg** (installer) and a **zip** (the auto-update feed needs zip), both
`arm64` + `x64`, with hardened runtime + `build/entitlements.mac.plist`. Icon is
generated from `assets/icon-source.png` (1254² PNG → `.icns` at build time).

Two electron-builder hooks (packaging-sensitive; leave them wired):
- **`afterPack` → `build/fuses.js`** flips Electron security fuses (disables
  `runAsNode`, NODE_OPTIONS/inspect, cookie-encryption on, asar-only). Now hardens
  **win32 *and* darwin** (mac re-signs ad-hoc after flipping; asar-integrity stays
  win-only until it can be verified on a Mac).
- **`afterSign` → `build/notarize.js`** notarizes the mac app **only when Apple
  creds are in the env** (`APPLE_ID`+`APPLE_APP_SPECIFIC_PASSWORD`+`APPLE_TEAM_ID`,
  or an `APPLE_API_KEY` set); otherwise it cleanly skips, so an unsigned local
  `build:mac:dir` still succeeds. Needs an Apple Developer account for a real
  release — unsigned mac apps are Gatekeeper-blocked with no easy "run anyway".

```bash
npm test             # node --test — unit/integration suite under test/
```
`npm test` now runs a **`node:test` suite** (`test/*.test.js`, zero extra deps)
covering the platform-detection helper (`main/platform.js`), the widget gating
(`renderer/widget-platform.js` + the real registry, incl. a `vm` simulation of a
macOS/Windows renderer boot), and the voice assistant's intent layer + contracts
(`test/voice-commands.test.js`, `test/voice-assistant.test.js` — the latter also
compiles and handshakes the real PowerShell speech host). Run it after touching
platform, registry or voice logic. There is still **no end-to-end/UI harness** — see §6 for how the
app is otherwise tested (the user drives it live on Windows).

### Runtime data
Stored under `%APPDATA%/main-launcher/`: Spotify tokens, settings JSON, caches,
logs, custom icons/backgrounds, `license.json`. **Never break the shape of
persisted data or localStorage keys** without a migration — users have live
state.

### Gotchas (these bite silently)
- **Never interpolate a value into a JS string inside an inline handler.** Write
  `onclick="fn(${jsAttr(x)})"`, never `onclick="fn('${esc(x)}')"`. `esc()` turns
  `'` into `&#39;`, and the HTML parser decodes that back to a real quote *before*
  the handler is compiled — so `esc()` there lets a crafted value (a Bluetooth
  device name, an imported preset name, a registry DisplayName) break out of the
  string and run as code with the full `electronAPI` surface. `jsAttr()`
  (`renderer/ui-utils.js`) supplies its own quotes; don't wrap it in any.
  `test/ui-escaping.test.js` fails the build if the old shape reappears.
- **Every renderer document ships a CSP** (`<meta http-equiv>` in all six HTML
  files). It denies remote script, `connect-src`, frames and forms. `script-src`
  still carries `'unsafe-inline'` only because of the inline `on*` handlers —
  migrate those to delegated listeners and it can be dropped. If you add a
  genuinely new remote resource, widen the policy or it fails silently.
- **Licensing config is baked in, not env-driven.** `MAIN_SITE_URL`,
  `LICENSE_VERIFY_SECRET` and the Google OAuth env vars are honoured **only when
  `!app.isPackaged`** (`main/license.js`), so a shipped build can't be pointed at
  another licensing authority. Google desktop credentials go in the
  `GOOGLE_DESKTOP_CLIENT_ID`/`_SECRET` constants at the top of that file — while
  they're blank the gate hides the Google button and key-paste is the only route in.
- **A guard must never treat missing evidence as a pass.** The rollback watermark
  (`main/licenseWatermark.js`, pure + unit-tested) is kept in *two* places —
  `license.json` and a `safeStorage`-encrypted mirror — because the original
  `typeof stored.maxSeen === 'number' && …` check let deleting one field skip the
  check itself. Same shape to watch for anywhere else entitlement is decided.
- **Tailwind is a static vendored build** (`styles/vendor/tailwind.css`), not
  the CDN. A new Tailwind class in HTML/JS does nothing at runtime until you run
  `npm run build:css` and commit the regenerated file.
- **Custom icons/backgrounds load synchronously at preload** via
  `sendSync('get-icons-base-path-sync' / 'get-backgrounds-base-path-sync')` so
  they apply before first paint (no flash). Don't move that read later.
- **FFmpeg** ships via `ffmpeg-static` and is `asarUnpack`ed — packaging-
  sensitive, don't assume the binary path is inside the asar.
- **Spotify:** preserve the PKCE OAuth flow and safe token-refresh logic.
- **Lyrics:** LRC timing is race-sensitive; don't introduce async that reorders
  line application.

---

## 3. ValClips Quality (`main-appv2.4-main/valclips-quality/`)

A **separate Electron app** (its own `package.json`, its own FFmpeg), launched
from Main. Maximum-effort encoder for ~20s Valorant TikTok edits: VMAF-guided
quality, size-cap default, chroma boost.

- **Stack:** electron-vite + React 19 + TypeScript. `src/main/` (Node/Electron),
  `src/preload/`, `src/renderer/` (React), `src/shared/` (types + pure encode
  logic shared across processes — `decision.ts`, `encodeArgs.ts`, `filters.ts`).
- **Encoding pipeline:** `pipeline.ts` orchestrates `probe` → `analyze` →
  `hotspots` → `encode`/`vmaf` → atomic commit (`atomic.ts`). `run.ts`'
  `runOrThrow()` is the shared subprocess wrapper.
- **Commands (run from the valclips dir):**
  ```bash
  npm run dev      # electron-vite dev
  npm run build    # electron-vite build
  npm test         # vitest run  ← this app HAS tests; run them after changes
  ```

---

## 4. Website (`website/`)

Next.js 14 App Router marketing + commerce site. Sells the desktop app and
provisions license keys.

- **Auth:** NextAuth (Auth.js) with Google provider (`src/lib/auth.ts`), Prisma
  adapter. Models in `prisma/schema.prisma`: `User`, `Account`, `Session`,
  `VerificationToken`, `License`, `Activation`, `Purchase`.
- **DB:** **Postgres in every environment** (SQLite breaks on Vercel's
  ephemeral FS — see the schema comment). `DATABASE_URL` must be a hosted
  Postgres. `prisma/dev.db` is a local artifact and gitignored.
- **Commerce:** PayPal checkout (`src/lib/paypal.ts`), license provisioning
  (`src/lib/provision.ts`, `src/lib/license.ts`), product config
  (`src/lib/product.ts`).
- **License hardening:** licenses are **Ed25519-signed, machine-bound tokens**.
  The server signs a token (`src/lib/licenseToken.ts`) tied to a machine on
  `Activation`; the desktop app verifies the signature offline against a public
  key (`main/license.js`). This closes the forge / fake-server / key-sharing
  bypasses — keep the signing key server-side and the verify path client-side.
- **Static data & types:** copy/config for accents, features and the widget
  catalog live in `src/data/` (`accents.ts`, `features.ts`, `widgets.ts`);
  shared TS types in `src/types/`. Other notable `src/lib/`: `activation.ts`,
  `licenseToken.ts`, `admin.ts`/`adminEmails.ts`, `email.ts`, `rateLimit.ts`,
  `site.ts`, `prisma.ts`.
- **Theming:** accent-variable driven (`AccentProvider` / `AccentPicker`,
  `globals.css`). Prefer CSS accent vars over hardcoded colors.
- **`cn()`** (`src/lib/cn.ts`) is the className-merge helper used across every
  component — it's the most-referenced node in the whole repo. Keep its
  signature stable.
- **Commands (run from `website/`):**
  ```bash
  npm run dev        # next dev
  npm run build      # prisma generate && prisma migrate deploy && next build
  npm run lint       # next lint
  npm run db:migrate # prisma migrate dev (local schema changes)
  npm run db:studio  # inspect the DB
  ```
- **Downloads:** the gated `/download` page serves both builds via
  `DownloadButtons` (OS-auto-detected). `DOWNLOAD_URL` = the Windows installer,
  `DOWNLOAD_URL_MAC` = the macOS `.dmg` (optional — the Mac button hides when
  unset). One license unlocks both.
- **Env:** never commit `.env*` (gitignored). Needs `DATABASE_URL`, Google OAuth
  creds, NextAuth secret, PayPal creds, `DOWNLOAD_URL` (+ optional
  `DOWNLOAD_URL_MAC`). Keep a `.env.example` in sync when you add a new required var.

---

## 5. Cross-cutting conventions

- **Preserve functionality.** Don't remove features or change IPC/preload
  boundaries or persisted-data shapes unless explicitly asked. Ship complete,
  integrated features — no placeholders or partial stubs.
- **Logging:** desktop-app errors go through the `logger.js` Logger — no silent
  failures.
- **Versioning:** desktop app + website move together; bump both `package.json`
  versions and note modified files when you cut a release. ValClips versions on
  its own.
- **Match the neighbours.** Each app has its own idiom (vanilla-JS/CommonJS vs
  React/TS vs Next). Write code that reads like the file it's in.

---

## 6. How this project is tested (important)

**The user runs the desktop app and tests it live themselves.** Do **not**
launch a long-lived instance and sit polling its logs, and do **not** kill the
user's running instance to start your own. Make the change, tell the user what
to exercise, and let them drive. ValClips is the exception — it has a Vitest
suite; run `npm test` there after touching encode/shared logic.

---

## 7. Architecture hotspots (from the code graph)

A knowledge graph of this repo lives in `graphify-out/` (2,119 nodes, built from
AST — no LLM). Useful facts it surfaced, worth knowing before refactoring:

- **`main/shellUtils.js` → `runCmd()`** and **`main/scriptCache.js` →
  `ensureVersionedScript()`** are the highest-coupling hubs. Nearly every
  privileged/PowerShell feature (autostart, appInstaller, appLauncher,
  controllerMacros, fpsOptimizer) routes through them. Change their signatures
  with care — the blast radius is large.
- **Persistent-helper pattern.** Two features can't afford a process spawn per
  action, so they keep a long-lived PowerShell/C# helper and talk to it over a
  line protocol on stdin/stdout: `main/macros.js` (input engine) and
  `main/voiceAssistant.js` (`main/voiceHostScript.js` — offline speech
  recognition + TTS + a passive push-to-talk key watch). Both compile their core
  with `Add-Type`, both version their cached `.ps1` through
  `scriptCache.ensureVersionedScript`, and both are torn down on `will-quit`.
  If you change one side of either protocol, change the other — the tests assert
  the two halves still agree.
- **Voice mic ownership.** The speech host has two listening modes: `command`
  (full grammar, streams audio levels for the overlay) and `wake` (only the
  "hey main" grammar, silent, continuous). `MODE` switches between them by
  toggling `Grammar.Enabled` — it never re-acquires the audio device, which is
  what makes waking instant. Only `STOP` releases the mic. Everything routes
  through `setHostMode()`/`reconcileMic()` in `main/voiceAssistant.js`; never
  send `LISTEN`/`STOP` from anywhere else, or wake and command mode will fight
  over the device. The wake word is **off by default** because turning it on
  keeps the microphone open while idle.
- **Voice command catalogue.** `main/voiceCommands.js` holds ~90 commands; every
  one MUST have an executor in `renderer/voice-assistant.js` (or be one of the
  four assistant-meta commands handled in `main/voiceAssistant.js`) — a test
  fails the build otherwise, so a command can never be advertised without an
  implementation. Slots fed by live data (apps, widgets, Bluetooth devices,
  audio sessions, playlists, routines) come from the renderer via
  `voice:set-vocabulary`. Chaining ("do X and Y") is a grammar REPETITION, not a
  cross product — keep it that way or the grammar squares. Routines are the
  user's own named sequences, stored in `voiceRoutines` (localStorage); each
  step is resolved through the same matcher over `voice:match`, so a routine can
  never reach a capability a spoken command couldn't.
- Several communities (controller-macros UI, valclips UI, background) have **low
  internal cohesion** (~0.06) — candidates to split into tighter modules.
- ~569 weakly-connected nodes are mostly library imports / config, but some may
  be **dead code or missing edges** — worth a look during cleanup.

### Querying the graph instead of grepping (saves tokens)
For **cross-file / "what-connects-to-what" questions**, query the prebuilt graph
before opening many files:
```bash
/graphify query "what depends on runCmd()?"
/graphify path "App Installer widget" "shellUtils"
```
After significant code changes, refresh it (free, AST-only):
```bash
/graphify . --update
```
For questions about a single known file, just open the file — the graph is for
relationships, not line-level detail.

---

## 8. Quick reference: where things live

```
main-appv2.4-main/main-app11/main-app/
  main.js            # Electron main entry
  preload.js         # the ONLY renderer↔main bridge (window.electronAPI)
  main/<feature>.js  # main-process feature modules (IPC handlers, OS work)
  renderer/core.js   # renderer bootstrap + MINI_WIDGETS registry (source of truth)
  renderer/<feat>.js # per-feature UI logic (vanilla JS)
  styles/vendor/tailwind.css  # vendored build — rebuild with npm run build:css
main-appv2.4-main/valclips-quality/src/{main,preload,renderer,shared}/
website/src/{app,components,lib}/  +  website/prisma/schema.prisma
graphify-out/        # code knowledge graph (query it; don't hand-edit)
```
