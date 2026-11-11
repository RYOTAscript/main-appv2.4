# CLAUDE.md

Guidance for Claude Code when working in this repository. This file auto-loads
at the repo root. Keep it accurate — when you change how something is built,
run, or wired, update this file in the same change.

---

## 1. What this repo is

A **monorepo with four independent apps** that ship one product ("**main**", a
Windows gaming/productivity launcher):

| App | Path | Stack | Purpose |
|-----|------|-------|---------|
| **Desktop app (Main)** | `main-appv2.4-main/main-app11/main-app/` | Electron 42, CommonJS, vanilla JS + vendored Tailwind | The always-on desktop overlay. The product itself. |
| **ValClips Quality** | `main-appv2.4-main/valclips-quality/` | electron-vite, React 19, TypeScript, Vitest | Standalone TikTok/Valorant clip quality tool, launched from Main. |
| **Website (main-website)** | `website/` | Next.js 14 (App Router), Prisma + Postgres, NextAuth, PayPal | Marketing + commerce site: sells licenses, provisions keys. Also hosts the Phone Remote page (`public/remote/`). |
| **Phone relay** | `relay/` | Cloudflare Worker + Durable Object, plain JS (ESM), node:test | Passes the Phone Remote's end-to-end encrypted messages between Main and a phone. |

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

**Registry: 36 widget entries.** Windows shows 30, macOS shows 27. Three kinds:
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
  requires ~32 feature modules from `main/`. Feature logic lives in `main/*.js`
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
  (`main/crosshair.js`), the mic-mute overlay (`main/micMute.js`), the
  floating timers (`main/timers.js`), the corner player (`main/miniPlayer.js`), the hidden Phone Remote socket window (`main/phoneRemote.js`),
  the first-run welcome (`main/firstRun.js`) and the license gate. FPS-optimizer
  kill sweeps protect all of them by PID + image name so they can never
  self-terminate. **Each gets its own narrow preload** (`<window>-preload.js`)
  exposing only what that window does — never the main `preload.js`, which
  would hand a child window the entire `electronAPI` surface. A transparent
  window whose page fails to load still OPENS, as an invisible rectangle with
  no error anywhere, so wire `did-fail-load` and add the page + its preload to
  `package.json`'s `files` whitelist.
- **First run:** the NSIS installer is `oneClick` and shows no license page, so
  `first-run.html` is the ONLY place the user is told what they are agreeing to
  — the "By continuing you agree to the Terms and Privacy Policy" line under the
  button is the product's whole click-through acceptance. Its links go through
  `first-run:open-legal`, which takes a KEY (`terms`/`privacy`) and resolves it
  against a closed map built from `license.js`'s exported `SITE_URL`; the page
  can never name a URL. `eula.txt` is no longer referenced by the build.
  `test/first-run.test.js` pins all of this.

### IPC pattern (follow it exactly)
Renderer → `window.electronAPI.someCall()` (in `preload.js`) →
`ipcRenderer.invoke('channel', …)` → `ipcMain.handle('channel', …)` in the
feature's `main/*.js`. ~30 main modules register handlers (~210 channels total).
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

The registry holds **36 widget entries** across 12 categories (Audio, Clipboard,
Displays, Gaming, Media, Productivity, Searching, Social, Spotify, System,
Utilities, Weather); the Widget Library shows the OS-filtered subset — **30 on
Windows, 27 on macOS**. The Widget Library, its search index, the dashboard Mini
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
mapping. On Windows the filter keeps all 30 Windows widgets and defaults to
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
platform, registry or voice logic.

Two suites cover things that fail *silently* in a running app, where nothing
errors and nobody notices:
- **`test/csp.test.js`** parses every HTML file's Content-Security-Policy the
  way a browser does and asserts against the parsed directives — see the
  CSP-comment gotcha below for the bug that motivated it.
- **`test/animation-idle.test.js`** runs the real `renderer/beat-glow.js` in a
  `vm` with a DOM that COUNTS lookups, style writes and storage reads, and caps
  what an idle animation frame may cost. The two rAF loops there run for the
  whole session and are never cancelled, so per-frame waste is permanent and
  invisible — it only costs anything when nothing is happening. Add a counting
  assertion here for any new always-on loop.
- **`test/first-run.test.js`** pins the welcome window's narrow bridge and its
  acceptance notice (see §2's first-run note).

When writing a "this must NOT appear in the source" assertion, strip comments
first. The comment explaining why something is absent contains the very word the
assertion forbids, so it trips its own check — both negative assertions in
`first-run.test.js` did exactly that on the first run.

There is still **no end-to-end/UI harness** — see §6 for how the
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
- **Every renderer document ships a CSP** (`<meta http-equiv>` in every HTML
  file, each listed in `test/csp.test.js`). It denies remote script, `connect-src`, frames and forms. `script-src`
  still carries `'unsafe-inline'` only because of the inline `on*` handlers —
  migrate those to delegated listeners and it can be dropped. If you add a
  genuinely new remote resource, widen the policy or it fails silently. The one
  page allowed `connect-src` is `phone-remote.html` (the relay socket), pinned
  exactly in the test's `CONNECT_ALLOWED`.
- **Never put a comment inside a CSP `content=""` attribute.** CSP has no
  comment syntax. `/*` parses as a directive NAME, which is invalid, so the
  parser discards that directive *and everything up to the next `;`* — which is
  the directive you actually wrote on the next line. `voice-overlay.html` had a
  `/* … */` note sitting above `img-src`, so img-src never existed, everything
  fell through to `default-src 'none'`, and album art was blocked in the voice
  overlay for every build that shipped it. Nothing surfaces this: the page
  renders, the image is simply never there. The old test asserted the policy
  TEXT with a regex and passed the whole time. `test/csp.test.js` now *parses*
  every policy the way a browser does and fails on any directive that would be
  thrown away — assert against parsed directives, never against the source text.
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
- **Never set `win.publisherName` while the build is unsigned.** It is written
  into `app-update.yml`, and electron-updater's `NsisUpdater.verifySignature()`
  skips signature checking *only* when that key is absent
  (`if (publisherName == null) return null`). With it set, every downloaded
  update is put through `Get-AuthenticodeSignature`, and an unsigned installer
  is rejected with `ERR_UPDATER_INVALID_SIGNATURE` — auto-update dies silently
  for **every** release, and the failure only surfaces on a second machine that
  actually has an older version installed. It was set from `f465a1b` to v4.1.0
  and broke updates for that whole range. When real code signing is added the
  value is derived from the certificate's CN automatically, so it still should
  not be hardcoded. Note also that the *installed* app does the verifying: a
  client shipped with the bad key can never be fixed by a later release, only
  by a manual reinstall.
- **`build` in package.json is schema-validated.** electron-builder rejects
  unknown keys outright, so you cannot leave a `"_comment_"` field in there to
  explain a decision — the build fails at `validateConfiguration`. Document it
  here instead.
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
- **Phone Remote page (`public/remote/`)** is a STATIC page — `index.html`,
  `remote.css`, `remote.js` and `protocol.js` — served at
  `/remote/index.html`, deliberately NOT a Next route: a route would inherit
  the site chrome and the site manifest, and with that manifest present iOS
  "Add to Home Screen" saves the manifest's `start_url` (`/`) instead of the
  page, dropping the pairing fragment. As a plain page it saves its own
  address, `#k=…` included. `protocol.js` is a byte-identical copy of the
  desktop app's `renderer/remote-protocol.js` (a desktop test fails if they
  drift — copy the file over after editing it). Own CSP: `script-src 'self'`,
  no inline script or handlers, `connect-src` only `wss:` (+ loopback for a dev
  relay). Wire data is drawn with textContent only (test-guarded).

---

## 4b. Phone relay (`relay/`)

A Cloudflare Worker + Durable Object (`src/worker.js`, `src/room.js`; pure
rules in `src/rules.js`) that pairs one PC with up to four phones per room and
forwards sealed envelopes between them, using the WebSocket Hibernation API
(keep-alive pings are auto-answered without waking the object). It never sees
the pairing secret, so it can't read or forge anything. A PC must present its
license token, checked with the same Ed25519 public key as `main/license.js`
(`LICENSE_PUBLIC_KEY_HEX` — a desktop test pins the two together); phones need
only the room id. Limits: 64 KiB messages, a per-socket token bucket, a fifth
phone is turned away (close 4001), a second PC replaces the first (4000).

- **Commands (run from `relay/`):**
  ```bash
  npm test                   # node:test, no deps
  npx wrangler@4 login       # once — the user clicks Allow in the browser
  npx wrangler@4 deploy      # prints https://main-phone-relay.<sub>.workers.dev
  ```
- Deployed at `main-phone-relay.main-phone-relay.workers.dev`, which is baked
  into `RELAY_HOST_DEFAULT` in the desktop app's `main/phoneRemote.js`;
  `MAIN_PHONE_RELAY` overrides it in dev runs only. Redeploy with
  `NODE_USE_SYSTEM_CA=1 npx wrangler@4 deploy` on a machine behind a
  TLS-inspecting proxy. See `relay/README.md`.

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
- **Voice answering layer.** `main/voiceResponses.js` (pure, no imports) turns a
  command result into what the assistant *says* and what the overlay *shows* —
  they are deliberately different: "what's the weather" speaks a sentence and
  displays a large `21°`. Phrase pools ROTATE rather than picking randomly, so
  replies vary, never repeat back-to-back, and stay deterministic for tests. An
  executor may return a rich `answer: { speech, headline, detail, meta[] }`,
  which wins over the pools; it is whitelisted field-by-field when it crosses
  IPC in `renderer/voice-assistant.js` and rendered as the overlay's answer card.
- **Never rewrite an utterance before matching it.** A synonym table collapsing
  "lower" → "turn" looks like a recognition win and silently breaks commands:
  "lower the volume" is ALREADY a template, and the rewrite produces "turn the
  volume", matching neither it nor "turn the volume down". Same trap for filler
  stripping — "like" is not a filler, it is how you favourite a track. Only
  `INNER_FILLERS` is stripped, and a test asserts that list stays disjoint from
  every word the registry uses. Add new wordings to a command's `phrases`.
- **A slot's unit belongs to the value, not the template.** `"{minutes} minutes"`
  forces every duration to end in that word, so "half an hour" compiles into the
  grammar as "half an hour minutes". The unit lives in the slot entry's `spoken`
  instead, which lets numbers and idioms share one template. Remember recognition
  runs on a CLOSED grammar: a phrasing `matchIntent` can parse is still unhearable
  unless it is also compiled in as a choice.
- **A hidden BrowserWindow is throttled, and that breaks readiness handshakes.**
  Chromium stops `requestAnimationFrame` and clamps `setTimeout` in a hidden or
  occluded window. The voice overlay is hidden whenever it is idle, so the
  `painted` signal it sends before being shown never arrived, and every popup
  waited out the 400ms reveal fallback instead (measured 428ms; ~20ms after the
  fix). `backgroundThrottling: false` in its `webPreferences` is what makes it
  work; a timer racing the rAF is NOT enough on its own, because the timer is
  throttled too. The same throttle is what freezes an entrance animation
  mid-flight. Any new always-on-top HUD window needs the same flag.
- **Two speech processes, deliberately.** `main/voiceHostScript.js` owns the
  microphone and recognition; `main/voiceSpeaker.js` is a SEPARATE PowerShell
  helper that speaks through WinRT `Windows.Media.SpeechSynthesis`. SAPI5 (which
  System.Speech uses) can only see the older "Desktop" voices; WinRT reaches the
  OneCore ones (David/Mark/Zira, and Aria/Jenny where installed). They are split
  so a failure in the nicer-voice path can never take down the microphone — if
  the speaker does not report READY within 6s, speech falls back to the host's
  SAPI voice and recognition is untouched.
- **A closed grammar makes unheard phrasings INAUDIBLE, not misheard.** That is
  the real reason the assistant "doesn't understand me". Three layers now
  address it: ~380 phrasings in the registry, an n-best re-rank of the engine's
  alternates against the real command list, and a `DictationGrammar` catch-all
  (`freeform` setting) sitting beneath the command grammar. Note
  `DictationGrammar` throws on `Priority` — dominance is asserted from the other
  side by raising `commandGrammar.Priority`.
- **The recognizer cannot say "that was not a command".** A closed grammar only
  returns which of its ~800 phrases the audio sat nearest, so room noise is not
  rejected, it is ROUNDED — during testing this opened Settings with nobody
  speaking. Three defences, all in `main/voiceCommands.js` + `voiceAssistant.js`:
  risky commands (`RISKY_COMMANDS`) need 0.92 confidence or they confirm; the
  always-listening wake path adds a penalty on top; and a result whose peak
  audio level never rose is discarded (skipped entirely until 3 level samples
  prove the meter works — a broken meter must silence nothing). `main/
  voiceEngines.js` records this as an ENGINE property (`canRejectOutOfGrammar`),
  so anything that exists because of the closed grammar branches on the engine
  rather than on the OS.
- **`runCmd(cmd, timeoutMs)` takes a command STRING; `runFile(file, argv, ms)`
  takes an argv array.** Both resolve `{ ok, stdout, stderr, code }`, never a
  bare string. Passing an array to runCmd silently runs the bare command and
  the caller sees an empty result, not an error.
- **PowerShell built from an array must join with newlines, not `'; '`.** A
  semicolon straight after `[ordered]@{` closes the hash literal and the whole
  script fails to parse.
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
- **The Calendar is split three ways, on purpose.** `renderer/calendar-engine.js`
  is a UMD module of PURE date logic (recurrence expansion, reminder due-times,
  the natural-language quick-add parser, sanitising) loaded BOTH as a renderer
  `<script>` and via `require()` from `main/calendar.js` — one copy, so the UI
  and the scheduler can never disagree about when something happens.
  `main/calendar.js` owns the data (`calendar.json` + a small
  `calendar-runtime.json` for the watermark/snoozes/history) and the reminders;
  `renderer/calendar.js` is only UI. Reminders live in main because a hidden
  BrowserWindow throttles timers — a renderer-side alarm would not fire while
  the launcher sits in the tray. Everything stored is LOCAL WALL-CLOCK time
  (`'YYYY-MM-DDTHH:mm'`), never a UTC instant, so a weekly 10:00 class stays at
  10:00 across a DST change; durations are computed on a linear "wall minute"
  scale for the same reason. The scheduler is ONE `setTimeout` aimed at the next
  due reminder (capped at 15 min, re-armed on `powerMonitor` resume), and what
  is due is decided by the pure, tested `scan()`: reminders fire when their time
  falls in `(watermark, now]`, several due reminders for one occurrence collapse
  into the closest one, and anything that came due while main was away and is no
  longer useful is reported as a single "missed" summary instead of a burst.
- **Timers (registry id `timer`) use the Calendar's split.** `renderer/timer-engine.js`
  is the pure UMD engine (countdowns, stopwatch, Pomodoro phases, `scan()`,
  duration parsing, window-geometry clamping), loaded by the panel, the floating
  windows AND `main/timers.js`. Main owns `timers.json`, the ONE-setTimeout
  scheduler (a running countdown stores its wall-clock `endAt`; repeats schedule
  from the previous end so they never drift; rounds missed while asleep collapse
  into one "missed" event that never rings), native notifications, the global
  hotkeys and the **floating timers**: one frameless, transparent, always-on-top
  window per popped-out timer (`timer-float.html`, `backgroundThrottling: false`,
  its own `timer-float-preload.js`). A floating window never names a timer id —
  main resolves it from `event.sender` and only accepts `FLOAT_ACTIONS`. Windows
  remember position/style/size/opacity/ghost per timer and are clamped back onto
  a real display on `display-removed`. Changing a float's look goes
  hide → send new state → `setBounds` → page reports `timer-float:laid-out` at the
  new size → reveal (450ms fallback): resizing and restyling otherwise land at
  different moments and the ring draws inside a pill-shaped window. Checkpoints are
  stored as time LEFT (`leftMs`, so a nudge keeps "5 min left" meaning 5 min left),
  are per-round (`hit` resets on repeat), and several passed at once are one event. `renderer/timer.js` is UI only; it plays
  the alarm by scheduling the whole ring on the WebAudio clock up front (not
  throttled in a hidden window). The old `timerStart`/`getTimerState`/… globals
  stay for the voice executors, and a pre-2.0 `localStorage.timerState` is handed
  to main once via `timer:import-legacy`. Covered by `test/timer-engine.test.js`
  and `test/timer-wiring.test.js`.
- **The Corner Player (registry id `miniPlayer`) polls Spotify from MAIN.** It is
  a tiny always-on-top card (`mini-player.html`, its own
  `mini-player-preload.js`, `backgroundThrottling: false`) that is on screen
  mostly while the launcher sits hidden — exactly when the renderer's own
  2.5s Spotify poll is throttled. So `main/miniPlayer.js` polls through the
  functions `main/spotify.js` now exports (`getCurrentTrack`/`control`/`seek`,
  the same ones its IPC handlers call) and looks lyrics up through
  `main/lyrics.js`'s `getLyrics` (shared cache). It only polls while it could
  be visible ("only while Main is hidden" by default; it follows the main
  window's show/hide/minimize/restore), hides while nothing is playing and
  while the full-screen lyrics stage is immersive (`lyrics-set-immersive`
  tells it). `renderer/mini-player-engine.js` is the pure UMD rule book shared
  by main and the page: corner placement (the window stays INSIDE the work
  area so its transparent edge never eats taskbar clicks), drag-to-snap,
  visibility, and the current lyric line — with the SAME lead as the
  launcher's "Lyrics Timing" slider, which the renderer pushes over
  `mini-player:sync` together with the accent colour (main can't read either).
  The page is idle-cheap like the floating timers: the progress bar and the
  disc are each ONE transform animation on the compositor (never `width`/`left`
  — that is main-thread layout on every frame for as long as music plays) and
  one setTimeout wakes for the next second or lyric line. Off screen it stops
  everything outright (`rest()`): this window is never throttled, so anything
  left running would run for as long as the card stayed hidden. **A poll must
  never show.** Spotify's position lands a few hundred ms off every 2.5s, and
  taken literally that made a lyric line drop back and come straight in again
  and the bar hiccup. So the page keeps its own clock that polls only CORRECT
  (`followClock`: under `DRIFT_JUMP_MS` it is noise and gets nudged, at or over
  it somebody really moved the song), `settledLine` never steps back for a
  small correction, and main holds a command's result over a stale poll
  (`applyHolds`, the Phone Remote's rule) and rides out a few failed polls
  before giving up on the song. The lyric rows are a conveyor — the next line
  glides up into the current one; only transform and opacity animate. The glow
  is a `::before` copy of the line (it fades without repainting) with the SAME
  text-shadow as the launcher's `.lyrics-slot-current` (test-pinned), and each
  row is padded by `--glow-room` with matching negative offsets: the ellipsis
  needs `overflow: hidden`, which otherwise shears the glow off at the text's
  edge — the first version's bug. Coming and going is a handshake: the card is
  `opacity: 0` until main shows the window and sends `presence: 'in'`; to
  leave, main sends `'out'` and hides the window `LEAVE_MS` later. Spotify text
  only ever goes in via `textContent`. Main checks every window message's
  sender and accepts only `MINI_ACTIONS`. Settings (lyric line, Glass/White
  style, when to show, corner) live in `mini-player.json`; the on/off switch is
  the registry pref, which main hears through `applyMiniPlayerEnabled`. Covered
  by `test/mini-player-engine.test.js`, `-wiring`, `-motion` (the real page
  script in a `vm` with a counting DOM on a virtual clock) and `-main` (the
  real main module with Electron and Spotify stubbed).
- **Player Style (Glass / White) is one setting for two surfaces.**
  `spotifyPlayerStyle` (localStorage; Settings → Spotify → Player Style, the
  full-screen stage's top bar, and the Full Screen Lyrics panel) restyles the
  dashboard player AND the full-screen stage together; the corner player keeps
  its own. `renderer/player-style.js` only flips `.player-white` on
  `#widget-spotify` / `#fullscreen-lyrics`; every White rule lives in
  `styles/player-style.css`, scoped to one of those ids — a test fails on an
  unscoped selector, so White can never leak into Glass. The card re-points the
  theme variables (`--accent`, `--text-*`, `--tile-*`) at ink so everything
  theme-coloured follows, and switches the glows off (on paper they read as
  smudges). The White record is the SAME spinning `#spotify-disk` repainted: its
  padding turns the image into a 24px centre label and the sync swaps its src for
  the sleeve's cover — a transparent GIF when there is none, because an `<img>`
  with no src draws Chromium's broken-image icon even with `alt=""`. Never put a
  pseudo-element inside `:is()`: the browser drops the whole rule (test-guarded).
- **The full-screen stage owns no playback state.** Its transport,
  shuffle/repeat, heart and volume call the dashboard player's own functions, and
  the follow-loop mirrors the result back (`updateFslControls`), writing only on
  change — a frame where nothing changed does no DOM work, not even a lookup
  (test-guarded; the loop runs every frame the stage is open). Shuffle/repeat
  come from `spotifyModeState`, which every poll keeps current even while
  Spotify Enhanced is off; the heart is `spotifyEnhancedCurrentSaved`, which the
  stage fetches itself (`spotifyRefreshLiked(track, true)`) when the player's own
  heart is switched off. Up next reads `spotifyGetQueue` when its tab opens and
  ~700ms after a song change — never on a timer, the endpoint is rate-limited —
  and builds rows with textContent only. Covered by `test/player-style.test.js`.
- **The Phone Remote (registry id `phoneRemote`) is four pieces, one protocol.**
  `renderer/remote-protocol.js` is the ONE copy of the pairing crypto and the
  message rules (UMD, WebCrypto only), shared by main, the phone page
  (`website/public/remote/protocol.js`, byte-identical) and the tests. Pairing
  is a 32-byte secret made by the PC and shown once as a QR code
  (`renderer/qr-code.js`, an in-house encoder checked against the published
  tables and an independent reader in `test/qr-code.test.js`); it travels in
  the URL FRAGMENT, which never reaches a server. HKDF turns it into a relay
  room id and an AES-256-GCM key; each direction is bound into the AAD, so a
  PC message can't be bounced back as a command. Commands carry a timestamp +
  nonce (`ReplayGuard`, 2-minute window, stamped on the PC's clock via each
  state's `ts`) and are rate-limited; states carry `sid`/`seq`, so a replay
  can't wind the phone back. `main/phoneRemoteHost.js` is the Electron-free
  session logic (polls Spotify ONLY while the relay reports a phone watching,
  holds a command's result over a stale poll, lyrics once per song, queue on
  request); `main/phoneRemote.js` is the glue: the secret (safeStorage), the
  panel IPC, and the relay socket — which lives in a HIDDEN WINDOW's preload
  (`phone-remote.html` + `phone-remote-preload.js`, exposes nothing), not in
  Node, because Chromium's network stack honours the OS certificate store and
  proxy that a TLS-inspecting antivirus needs (same reason as
  `main/netClient.js`). The relay URL is baked in (`RELAY_HOST_DEFAULT`;
  `MAIN_PHONE_RELAY` only in dev runs) and the socket carries the license token
  (`license.relayToken()`). Spotify's player calls come from the functions
  `main/spotify.js` exports (`setVolume`/`isSaved`/`setSaved`/`getQueue` were
  added beside the corner player's). Covered by `test/phone-remote-host.test.js`
  and `test/phone-remote-wiring.test.js`; the relay has its own `npm test`.
- **Spotify's Web API changed under the app (Feb/Mar 2026 dev-mode migration).**
  Removed endpoints answer 404, and `spotifyApiRequest` maps any 404 to
  `{ _noContent: true, _notFound: true }` — so a removed endpoint or "no active
  device" looks like an empty success unless the caller checks `_notFound`. Likes
  go through `/me/library` (URIs), playlists expose `items` not `tracks`. There is
  **no API to remove from the queue**, so removal drives the Spotify DESKTOP app via
  Windows UI Automation (`main/spotifyQueueScript.js`, IPC
  `spotify-desktop-queue-remove`): queue panel → "More options for <title>" →
  "Remove from queue". Three things were each verified live and each rule out an
  "invisible" removal: UIA `Invoke` on a Spotify menu item only CLOSES the menu (the
  action never runs), keys POSTED to Spotify's windows are ignored, and the menu only
  RENDERS while the window is visible — minimized, covered, or on another virtual
  desktop it stays pending and later pops open, stealing focus (Chromium treats all
  three as occluded/hidden and stops rendering). So the helper SHOWS Spotify for the
  moment of the removal: `ShowNoActivate` (SW_SHOWNOACTIVATE + raise, never activate),
  `SetFocus()` on the item, foreground + focus re-checked immediately before ONE real
  Enter, then `Finish` puts the window back (SW_SHOWMINNOACTIVE if it was minimized)
  and returns focus to whatever had it; main additionally refocuses the launcher.
  Success is only reported once the row is really gone; a menu that never appears is
  cancelled by closing/reopening the queue panel (`not-visible`). It matches Spotify's
  English labels. **Verify the row with a name-matched `FindAll`, never by walking every
  button:** on an 81-row queue the walk is so slow that removals which had ALREADY
  happened polled out and reported `not-removed`, so the user saw an error for a song
  Spotify had really removed. Verified live from a minimized window: 3/3 removed in
  ~3 s, window put back minimized, focus returned; a window found visible stays visible.
  Chromium also builds the accessibility tree lazily, and a FRESHLY started Spotify may
  never build it at all — with no tree the helper only sees ~25 shell elements and
  answers `no-queue`. `WM_GETOBJECT` (OBJID_CLIENT and UiaRootObjectId), UIA event
  subscriptions and repeated full walks all failed to switch it on; only relaunching
  Spotify with `--force-renderer-accessibility` did (that flag is a TEST tool — the app
  must never relaunch the user's Spotify). So the helper waits for the tree and main
  warms it via `spotify-desktop-queue-warm` when queue rows appear. Don't bring back skip-based "removal" — muting and
  stepping past tracks fought Spotify's multi-second state lag and never worked
  reliably.
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
website/public/remote/   # the Phone Remote page (static)
relay/src/           # the Phone Remote relay (Cloudflare Worker + Durable Object)
graphify-out/        # code knowledge graph (query it; don't hand-edit)
```
