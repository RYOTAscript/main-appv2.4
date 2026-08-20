# macOS Port — Feasibility & Conversion Report

**Scope:** Desktop app (`main-app11/main-app/`) + website download flow.
**App version analysed:** 3.48.6 · Electron 42.
**Bottom line:** The Electron *shell* ports to macOS almost for free. The
**features do not** — ~19 of ~31 feature modules shell out to PowerShell /
Windows-only tech (WinRT, ViGEm, TranslucentTB, winget, AppX, Win32 SendInput).
A Mac build is a **per-feature reimplementation project**, not a recompile.

---

## 0. Implementation status — SHIPPED (7 stages)

The port described below has been **implemented** across 7 stages, all developed
and tested from Windows (`npm test` → a `node:test` suite; Windows behavior kept
byte-for-byte identical throughout). What landed:

| Stage | What shipped |
|-------|--------------|
| **1 Foundation** | `main/platform.js`, `renderer/widget-platform.js`, `platforms` field on the `MINI_WIDGETS` registry, `platform` exposed via preload, `node:test` harness. |
| **2 Packaging** | electron-builder `mac` target (dmg + zip, arm64 + x64), `entitlements.mac.plist`, hardened runtime, `build/fuses.js` extended to mac, env-guarded `build/notarize.js` afterSign hook, `build:mac` scripts. Validated by electron-builder's own config loader. |
| **3 Core UX** | autostart already used `setLoginItemSettings` (mac minimize-others → osascript); clipboard text/image already cross-platform (mac file-drop via pasteboard/osascript); mac menu-bar tray icon. |
| **4 Audio/BSD** | mic mute + system volume via osascript (`main/audioMac.js`); File Search `/Volumes`; System Stats already portable. |
| **5 Proc/launch** | Quick Launch running-indicator via `ps` + Steam-on-mac path; appLauncher `open`/`Spotify.app`; **6 more widgets gated** + Windows-only modules skipped at init on mac. |
| **6 Identity** | license machine-binding → mac `IOPlatformUUID` (`main/machineId.js`, Windows hash unchanged); elevate + auto-update already mac-safe. |
| **7 Website/docs** | OS-aware two-button `/download` (`DOWNLOAD_URL` + `DOWNLOAD_URL_MAC`); this report + CLAUDE.md. |

**Phase 1 result: the macOS build shipped 14 of 25 widgets** (Media +
Productivity edition), with 11 Windows-only widgets hidden.

**Phase 2 (substitutes) — now shipped: the macOS build has 23 widgets.** Nine of
the 11 gated widgets got real mac substitutes:
- **Backend-swapped, same widget** (un-gated, cross-platform): **Bluetooth**
  (`blueutil`), **Screen Resolution** (`displayplacer`), **Claude Limit**
  (osascript send + `powerSaveBlocker`/`Notification`; the `~/.claude` reset
  reader is the shared, reliable path), **Game Mode** (osascript frontmost poll).
- **New darwin-only substitute widgets**: **Dock Styler** (←taskbar, `defaults
  com.apple.dock`), **macOS Tweaks** (←debloat, reversible `defaults`), **App
  Uninstaller** (←deep-uninstaller, `~/Library` sweep → Trash, allow-list
  guarded), **App Installer** (←winget, Homebrew Cask), **Free Up & Quiet**
  (←fps-optimizer, `purge` + graceful app-quit).
- Tool-dependent widgets return `{ needsTool }` → a legal **1-click install**
  (official brew.sh + MIT `blueutil`/`displayplacer`, install-on-demand).

**Macros** also got a mac widget (build-and-play): macOS can't silently *record*
input, so instead of recording you build a macro from steps (type / key / wait /
click / move) and play it by button or global hotkey — keyboard-only macros via
osascript (no install), mouse steps via `cliclick` (1-click install). So the mac
build is **24 widgets**.

**Only 1 feature stays Windows-only — Controller Macros** — a virtual gamepad
needs a signed DriverKit system extension (kernel-level) that can't be built or
tested from Windows and needs special Apple entitlements. Everything shipped uses
the OS's own tools or permissively-licensed OSS invoked as the user's action.

**Still requires a Mac to finish (can't be done from Windows):**
1. `npm run build:mac` on the Mac (with Apple Developer creds in the env) to produce a signed, notarized dmg + zip.
2. Publish the dmg + zip **and `latest-mac.yml`** to the same Vercel Blob store as the Windows artifacts (electron-updater auto-selects `latest-mac.yml` on mac).
3. Set `DOWNLOAD_URL_MAC` on the website to the dmg URL.
4. On-device testing of the osascript-backed features (mic mute, volume, clipboard files, Spotify auto-play) — command generation is unit-tested, runtime behavior is not.

---

## 1. Executive summary

| | |
|---|---|
| **Is a Mac build technically possible?** | Yes — `electron-builder` targets `mac` (dmg/zip); the window/tray/IPC/renderer layer is already cross-platform. |
| **Can you ship it by flipping `--win` to `--mac`?** | **No.** The app would launch and the UI would render, but the majority of widgets would be dead/erroring because their backends call `powershell.exe`. |
| **Realistic effort** | Large. ~12 features port cleanly-to-moderately, ~8 need a full Mac-native rewrite, ~4 have **no Mac equivalent** and must be hidden. Plus Apple code-signing + notarization (mandatory, paid). |
| **Recommended path** | Ship a **reduced-scope Mac edition** (media/productivity widgets), platform-gate the Windows-only widgets out of the registry, and add a second download button. |

The single deepest reason it's hard: **`main/shellUtils.js` → `runCmd()`** is a
thin wrapper over `child_process.exec`. It is itself cross-platform, but *every
command string handed to it is Windows syntax* (`powershell -Command …`,
`tasklist`, `winget`, `reg add`). ~13 modules route through it and ~11 through
`scriptCache.js` (which writes `.ps1` helper scripts to disk). Porting = swapping
the command payloads, module by module.

---

## 2. What's already portable (the free wins)

The process/window architecture needs almost no work:

- **Window shell** — `frame:false`, `transparent:true`, always-on-top overlay:
  all cross-platform Electron. On Mac you'd *add* `vibrancy`/`visualEffectState`
  for the native blur instead of faking glass, and consider `titleBarStyle`.
- **Tray** — `new Tray()` works on macOS (renders in the **menu bar**, not a
  taskbar). Needs a **template (monochrome) icon** to look native; the current
  colored tray icon will look wrong.
- **IPC / preload / contextBridge** — 100% portable, no changes.
- **Renderer** (`main.html` + ~41 `renderer/*.js`, vendored Tailwind) — pure
  web, portable. Only the *copy* ("Windows 10/11", taskbar references) changes.
- **FFmpeg pipeline** (ValClips, Video Editor, Lyrics extraction) — FFmpeg is
  cross-platform; `ffmpeg-static` ships a Mac binary. Just resolve the Mac path
  and re-test the arg strings. **These are your strongest Mac features.**
- **Quit behaviour** — `main.js:646` already does the Mac-idiomatic
  `if (process.platform !== 'darwin') app.quit()`. Someone anticipated this.

---

## 3. Feature-by-feature portability matrix

Legend — **✅ Port easy** · **🟡 Rewrite (Mac equivalent exists)** · **🔴 No Mac
equivalent / hide it**.

### ✅ Port easy — no OS shell, or Electron built-in covers it
| Feature | Module | Notes |
|---|---|---|
| Spotify (+ Enhanced, Full-Screen Lyrics) | `spotify.js`, `lyrics.js` | Web API + PKCE OAuth + LRCLIB HTTP. Fully cross-platform. |
| Weather | `weather.js` | HTTP geolocation/weather APIs. Portable as-is. |
| Crosshair overlay | `crosshair.js` | Transparent click-through Electron window. Portable. |
| Backgrounds / Displays / Parallax | `backgrounds.js`, `displaySettings.js` | Electron `screen` API. Portable. |
| Discord Rich Presence | `discordRpc.js` | Discord local IPC socket — cross-platform. |
| Timer, Quick Notes, Beat-glow, Visualizer, Tooltip | renderer-only | Pure JS. Portable. |
| ValClips Quality, Video Editor | `valclips.js`, `videoEditor.js` | FFmpeg. Swap binary path → works. **Flagship Mac features.** |
| System Stats | `systemStats.js` | `os.cpus()` etc. Portable; a couple of Windows-specific metrics degrade gracefully. |
| Auto-start | `autostart.js` (currently PS/registry) | **Replace with Electron's built-in `app.setLoginItemSettings()`** — one-liner, native Login Items. Easy win. |
| Clipboard history | `clipboard.js` (currently `Get/Set-Clipboard` PS) | **Replace with Electron's built-in `clipboard` module** + a poll loop. Cross-platform. |
| File Search | `fileSearch.js` | Node `fs`; already has a `win32` branch (`fileSearch.js:471`) — add a `darwin` branch (search `/Applications`, `~`). Mostly portable. |

### 🟡 Rewrite — feature makes sense on Mac, but the implementation is Windows CLI
| Feature | Module | Windows mechanism | macOS approach |
|---|---|---|---|
| Mic mute | `micMute.js` | Win32 CoreAudio via `Add-Type` | `osascript -e 'set volume input volume 0'`, or a native addon for true device mute + the overlay HUD stays. |
| Keyboard macros | `macros.js` | Win32 `SendInput` via `Add-Type` | CGEvent taps (needs a native module like `nut-js`) or AppleScript keystrokes; requires **Accessibility permission**. |
| Claude Limit auto-continue | `claudeLimit.js` | `SetForegroundWindow` + `SendKeys` | AppleScript UI scripting / Accessibility API. Requires Accessibility permission. |
| Bluetooth manager | `bluetooth.js` | WinRT `Windows.Devices.Radios`/Bluetooth (17 WinRT calls) | `blueutil` (Homebrew CLI) or a CoreBluetooth native addon. Full rewrite. |
| Screen resolution | `screenResolution.js` | PS display APIs | `displayplacer` CLI or CoreGraphics `CGDisplay` native addon. |
| App launcher / Quick Launch | `appLauncher.js`, `quickLaunch.js` | Enumerate Start Menu `.lnk`s | Enumerate `/Applications` + `~/Applications` `.app` bundles; launch with `open -a`. Moderate. |
| Volume mixer | `volumeMixer.js` | Win32 per-app audio sessions | **Hard** — macOS exposes no public per-app volume API. System volume via `osascript` is easy; per-app needs a virtual audio driver (out of scope). Recommend shipping *system* volume only on Mac. |
| FPS optimizer | `fpsOptimizer.js` | `tasklist`/`taskkill` + HKLM tweaks + service stops | Process sweep maps to `ps`/`kill` cleanly, but the registry/service "tweaks" have no Mac analogue. Ship as a lightweight "close background apps" tool or hide it. |
| Game Mode | `gameMode.js` | Windows Game Mode toggles | No macOS equivalent; reframe as "Do Not Disturb + close apps" or hide. |

### 🔴 No real Mac equivalent — platform-gate these out
| Feature | Module | Why it can't port |
|---|---|---|
| Translucent Taskbar | `taskbar.js` | Wraps **TranslucentTB**; macOS has no taskbar (menu bar + Dock instead). Concept doesn't exist. **Hide.** |
| Windows Debloat | `debloat.js` | Removes Windows **AppX** bloatware + HKCU tweaks. Entirely Windows. **Hide.** |
| Deep / Revo Uninstaller | `revoUninstaller.js` | Uninstall model is Windows registry + `winget`. Mac uninstall = trash `.app` + sweep `~/Library`; a *different* feature you'd build fresh, not a port. **Hide or rebuild.** |
| App Installer (Ninite-style) | `appInstaller.js` | Backed by **winget**. Mac equivalent is **Homebrew Cask** — buildable, but a from-scratch rewrite with a different catalog. **Hide, or rebuild on `brew`.** |
| Controller Macros | `controllerMacros.js` | Uses the vendored **`Nefarius.ViGEm.Client.dll`** (a Windows kernel-mode virtual-gamepad driver). There is **no macOS equivalent** for virtual controller injection without deep private-API/kext work. **Hide.** |

**Tally:** ~12 easy · ~9 rewrite · ~5 hide (25 registry widgets + sub-features).

---

## 4. How to platform-gate widgets (the clean mechanism)

The app already has a single source of truth — `MINI_WIDGETS` in
`renderer/core.js`. Add a `platforms` field per entry and filter at load:

```js
// in a registry entry
{ id: 'taskbar', label: 'Translucent Taskbar', platforms: ['win32'], … }

// where the registry is consumed (library, dashboard strip, settings, search)
const os = window.electronAPI.platform;           // expose via preload
MINI_WIDGETS.filter(w => !w.platforms || w.platforms.includes(os));
```

Because the Widget Library, search index, dashboard strip and Settings summary
**all generate from this registry**, one `platforms` field cleanly removes a
widget everywhere at once. Expose `process.platform` through `preload.js`
(`platform: process.platform`) so the renderer can branch. Main-process handlers
for hidden features can stay registered but no-op on non-Windows (several already
guard with `if (process.platform !== 'win32') return`).

---

## 5. Build & packaging changes

Current `package.json > build` is Windows-only. Add a `mac` target:

```jsonc
"mac": {
  "icon": "assets/icon.icns",          // NEW — need an .icns (not .ico)
  "category": "public.app-category.utilities",
  "target": [{ "target": "dmg", "arch": ["arm64", "x64"] },
             { "target": "zip", "arch": ["arm64", "x64"] }],  // zip = auto-update feed
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": true
},
"dmg": { "artifactName": "main-${version}-${arch}.dmg" }
```

- Add a `build:mac` script: `electron-builder --mac --publish never`.
  **Must run on macOS** (or a Mac CI runner) — you cannot produce a signed,
  notarized Mac build from Windows.
- **`assets/icon.icns`** required (you only have `icon.ico` today).
- **`ffmpeg-static`** already resolves per-platform; keep the `asarUnpack`.
- **`build/fuses.js`** (`@electron/fuses`) afterPack hook works on Mac too — keep
  it.
- **Universal vs per-arch:** target both `arm64` (Apple Silicon) and `x64`
  (Intel), or build a universal binary.

### Code signing + notarization (non-optional on modern macOS)
- Requires an **Apple Developer account ($99/yr)**, a **Developer ID Application**
  certificate, and notarization via `notarytool` (electron-builder automates it
  with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars).
- Without it, macOS Gatekeeper blocks the app ("app is damaged / can't be
  opened"). This is stricter than Windows SmartScreen — there is no "Run anyway"
  that a normal user will find.
- Features that inject input (macros, claudeLimit) / capture audio / control the
  system will trigger **TCC permission prompts** (Accessibility, Automation,
  Microphone). Declare usage strings in the entitlements plist / `Info.plist`.

---

## 6. Auto-update changes

`electron-updater` **already supports macOS** — but:
- macOS auto-update requires the app to be **signed** (unsigned Mac apps can't
  self-update via Squirrel.Mac).
- The feed needs a **separate `latest-mac.yml`** alongside the current
  `latest.yml` (which is Windows-only). electron-builder generates it when you
  build the mac target with `zip`.
- Host `latest-mac.yml` + the `.zip` on the same Vercel Blob store you use today.
  The `publish.url` in `package.json` already points at the updates feed; Mac
  clients will fetch `latest-mac.yml` from the same base URL automatically.

---

## 7. Website changes (add "Download for Mac")

Small and self-contained:

1. **`src/app/download/page.tsx`** — currently one button driven by a single
   `DOWNLOAD_URL` env var, hardcoded copy `"Windows 10/11 · 64-bit"` and
   `"Download for Windows"`. Change to two buttons:
   - `DOWNLOAD_URL_WIN` → "Download for Windows"
   - `DOWNLOAD_URL_MAC` → "Download for macOS (Apple Silicon / Intel)"
   - Optionally detect `navigator.platform` / UA client-hints to auto-highlight
     the visitor's OS (this must be a **client component** — the page is a
     server component today).
2. **Env** — add `DOWNLOAD_URL_MAC` to Vercel + `.env.example`. Keep
   `DOWNLOAD_URL` (Windows) for backwards-compat or rename to `_WIN`.
3. **License gate** — the `getUserLicense` purchase-gate and `LicenseKeyPill`
   are OS-agnostic; no change. One license works for both downloads (verify the
   client-side **machine-binding** in `main/license.js` uses a Mac-obtainable
   machine ID — see §8).
4. **Deploy manifest** (`/de` skill / Vercel Blob) — publish the `.dmg`/`.zip`
   and `latest-mac.yml` next to the Windows artifacts.
5. Copy edits sitewide: hero/pricing/steps that say "Windows" or reference the
   taskbar; the install steps mention SmartScreen — add the Gatekeeper
   equivalent ("right-click → Open" is unnecessary if notarized).

---

## 8. Cross-cutting risks to resolve early

- **License machine-binding** (`main/license.js`, Ed25519 signed tokens bound to
  a machine via `Activation`): confirm the machine-ID source works on macOS. If
  it reads a Windows-only identifier (MachineGuid, WMI UUID), you need a Mac
  fingerprint (`IOPlatformUUID` via `ioreg`, or `machine-id`). This gates the
  whole app — **verify first**, it's a launch blocker.
- **`elevate.js` (UAC relaunch)** — macOS has no UAC. Admin-gated actions use
  `sudo`/Authorization Services or (better) are redesigned to not need root.
  Most Mac features here shouldn't need elevation; drop the relaunch path on
  Mac (it already returns `unsupported` off-Windows).
- **Tray icon** — provide a `Template.png` monochrome variant or the menu-bar
  icon looks broken in dark/light menu bars.
- **Glass UI** — the fake-glass CSS works, but Mac users expect real vibrancy;
  switching to native `vibrancy` is a polish item, not a blocker.
- **Testing** — you test the app live on Windows. A Mac port needs a Mac to test;
  budget for a physical Mac or a Mac CI runner (mandatory for signing anyway).

---

## 9. Recommended phased plan

**Phase 0 — Decide scope.** Ship a **"main for Mac (Media + Productivity
edition)"**: everything in §3-✅ plus the easy rewrites (autostart→LoginItems,
clipboard→Electron clipboard, mic mute→osascript). Hide all 🔴 and the hard 🟡
(volume mixer per-app, controller macros, taskbar, debloat, uninstaller,
installer, game mode, fps optimizer). This is a genuinely useful ~15-widget app
and avoids the deep native work.

**Phase 1 — Shell + gating.**
- Add `platforms` to `MINI_WIDGETS`; expose `platform` in preload; filter the
  registry + hide Windows-only widgets.
- Add the `mac` build target, `.icns`, entitlements, template tray icon.
- Set up Apple Developer signing + notarization on a Mac/CI runner.
- Verify license machine-binding on macOS.

**Phase 2 — Port the ✅ + easy 🟡 backends** (Spotify/lyrics/weather already
work; FFmpeg features; autostart; clipboard; mic mute; file search Mac branch).

**Phase 3 — Distribution.** `latest-mac.yml` feed, dmg/zip to Blob, two-button
download page, env vars, copy edits.

**Phase 4 (optional, later) — hard rewrites** as native addons: Bluetooth
(blueutil/CoreBluetooth), macros/claudeLimit (Accessibility), screen resolution
(displayplacer), a Homebrew-backed App Installer.

---

## 10. One-paragraph answer

You can absolutely offer a Mac download, but treat it as a **new edition, not a
recompile**. The Electron shell, IPC, renderer, Spotify/lyrics/weather, and the
FFmpeg-based ValClips/Video Editor port with little effort; autostart, clipboard
and mic-mute are easy Electron/`osascript` swaps. In exchange you must
platform-gate out the five Windows-only widgets (taskbar, debloat, uninstaller,
winget installer, ViGEm controller macros), rewrite ~9 features against macOS
APIs, set up **Apple code-signing + notarization** (paid, Mac-only build), add a
`latest-mac.yml` update feed, and split the download page into Windows/Mac
buttons. The cleanest scope is a **reduced Media + Productivity Mac edition**
gated by a new `platforms` field on the `MINI_WIDGETS` registry.
