# macOS Test Brief — main v4.0.0

**For:** a Claude Code instance (or a human) running on the Mac.
**Goal:** verify the **v4.0.0 macOS port** actually works on real hardware — the
runtime behavior that could only be unit-tested from Windows.

The Windows dev machine proved all the *command generation* and *logic* (157
`node:test` tests pass). What a Mac must confirm is that those commands actually
do the right thing on macOS: `defaults`, `osascript`, `blueutil`,
`displayplacer`, `cliclick`, `ioreg`, `purge`, FFmpeg, and that the app boots and
gates widgets correctly.

> **If you are the Claude Code agent:** you can run everything in §1–§3 headlessly.
> §4 needs a **human at the Mac** to tap macOS permission prompts (Accessibility /
> Automation / Microphone) and to enter a password for the Homebrew install — a
> headless agent cannot click those TCC dialogs. Do §1–§3, then hand §4 to the
> human and collect results.

---

## 0. Get the code + run it

```bash
# 1. Clone (v4.0.0 is on master)
git clone https://github.com/RYOTAscript/main-appv2.4.git
cd main-appv2.4/main-appv2.4-main/main-app11/main-app

# 2. Node 18+ required. If missing: install Homebrew then Node (see §4a), or grab
#    it from nodejs.org.
node --version

# 3. Install deps FRESH on the Mac (never copy Windows node_modules — this pulls
#    the macOS Electron + macOS FFmpeg binaries)
npm install

# 4. Launch in dev mode (unsigned — no Gatekeeper/notarization needed to test)
npm start
```

The app is **purchase-gated**: at the license gate, paste a valid license key. It
machine-binds to this Mac via `IOPlatformUUID` (see §3, machine-id check). One
license unlocks both Windows and macOS.

---

## 1. Automated checks (headless-safe) ✅

### 1a. Test suite runs natively
```bash
npm test        # expect: 157 tests, 157 pass, 0 fail
```

### 1b. Static launch sanity (no crash on mac-only init)
```bash
# The app should reach the license gate / main window without throwing. If it
# exits immediately, capture the error:
npm start
# Watch the terminal + %APPDATA equivalent log: ~/Library/Application Support/main-launcher/logs/
```
Report any error from the `isMac` init block (dockStyler, macTweaks,
appUninstaller, macTools, bluetoothMac, screenResolutionMac, appInstallerMac,
macFreeUp, gameModeMac, claudeLimitMac, macMacros).

### 1c. Widget gating is correct on macOS
```bash
node -e 'const fs=require("fs");const WP=require("./renderer/widget-platform.js");
const lit=fs.readFileSync("renderer/core.js","utf8").match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/)[1];
const reg=eval("("+lit+")");
const mac=WP.filterWidgetsForPlatform(reg,"darwin").map(w=>w.id);
console.log("macOS widgets:",mac.length);            // expect 24
console.log("controllerMacros hidden on mac:", !mac.includes("controllerMacros")); // expect true
console.log("dockStyler shown on mac:", mac.includes("dockStyler"));               // expect true
'
```

---

## 2. Verify the mac backends actually work (headless-safe) 🔧

Run these **raw commands directly** — they are exactly what the widgets call.
Success here means the widget's backend is sound even before touching the UI.
(These are read-only / reversible; nothing destructive.)

| Widget | Command to run | Expect |
|---|---|---|
| **Machine ID** (license) | `ioreg -rd1 -c IOPlatformExpertDevice \| grep IOPlatformUUID` | one UUID line |
| **Dock Styler** | `defaults read com.apple.dock autohide` | `0`/`1` or "does not exist" |
| **Dock Styler (write+revert)** | `defaults write com.apple.dock autohide -bool true && killall Dock` … then `defaults delete com.apple.dock autohide && killall Dock` | Dock auto-hides, then reverts |
| **macOS Tweaks** | `defaults read com.apple.finder ShowPathbar` | value or "does not exist" |
| **Free Up** | `/usr/sbin/purge` (may take a few seconds) | exit 0 |
| **Free Up (app list)** | `osascript -e 'tell application "System Events" to get name of every process whose background only is false'` | comma-list of GUI apps |
| **Game Mode** | `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'` | the frontmost app name |
| **Mic Mute** | `osascript -e 'input volume of (get volume settings)'` | 0-100 (triggers Automation prompt — see §4) |
| **Volume** | `osascript -e 'get volume settings'` | `output volume:…` string |
| **Claude Limit** | `ls ~/.claude/projects 2>/dev/null && node -e 'console.log(require("./main/claudeCcReader").readCcLimit())'` | `{ ok:true, found:… }` |
| **App Uninstaller** | `defaults read /Applications/Safari.app/Contents/Info CFBundleIdentifier` | `com.apple.Safari` |

Tool-dependent (install first via §4a, or `brew install blueutil displayplacer cliclick`):

| Widget | Command | Expect |
|---|---|---|
| **Bluetooth** | `blueutil --power` and `blueutil --paired --format json` | `0`/`1`; JSON array |
| **Screen Resolution** | `displayplacer list` | per-display "mode …" blocks |
| **App Installer** | `brew list --cask` | installed casks (may be empty) |
| **Macros (mouse)** | `cliclick p` | current cursor position |

---

## 3. FFmpeg-backed widgets (headless-safe)
```bash
# ValClips + Video Editor rely on FFmpeg. Confirm the bundled mac binary resolves:
node -e 'console.log(require("ffmpeg-static"))'   # prints a path
"$(node -e 'process.stdout.write(require("ffmpeg-static"))')" -version   # prints ffmpeg version
```

---

## 4. Interactive checks — **need a human at the Mac** 👤

These trip macOS permission prompts (TCC) that only a person can approve, or need
a password. Do these by hand in the running app.

### 4a. Homebrew + CLI tools (1-click install flow)
In the app, open **Bluetooth** (or Screen Resolution / mouse Macros). If the tool
isn't installed you'll see **"Install …"**:
- If **Homebrew is missing**, clicking it opens Homebrew's official installer in
  **Terminal** — this triggers an **Automation prompt** ("main wants to control
  Terminal" → **Allow**) and the installer asks for your **password**. Finish it,
  then click **Install** again to get the tool itself.
- If Homebrew is present, it installs the tool silently. Confirm the panel then
  shows real data (paired devices / display modes).

### 4b. Permission-gated widgets (grant in System Settings → Privacy & Security)
| Widget | Permission it will ask for | Test |
|---|---|---|
| **Mic Mute** | Microphone + Automation | Toggle mute → mic input drops to 0, restores on toggle |
| **Macros** | Accessibility | Build a macro (Type "hello", Wait 200ms, Press return), hit **Test** → it types into the frontmost app |
| **Claude Limit** | Accessibility (to send) | Pick a target app, send a test prompt → it pastes + optionally Enter |
| **Game Mode** | Automation | Enable, make a rule for a fullscreen app, confirm the event fires |
| **Dock Styler / macOS Tweaks** | Automation (osascript/`killall`) | Flip a toggle → Dock/Finder visibly changes; toggle back → reverts |

### 4c. App Uninstaller (careful — but reversible)
Open it, pick a **safe throwaway app**, hit scan → review the leftover list (it
should only list files under `~/Library/…` matching that app's bundle id). If you
proceed, items go to the **Trash** (recoverable). Confirm the app + leftovers land
in Trash and nothing outside `~/Library`/`/Applications` is touched.

---

## 5. Optional — build a real mac app
```bash
# Unsigned .app for a packaging smoke test (right-click → Open to bypass Gatekeeper):
npm run build:mac:dir
# Full signed + notarized dmg/zip (needs Apple Developer creds in the env):
#   export APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=…
npm run build:mac
```

---

## 6. Report back
For each item, note **pass / fail / needs-permission**, and for any failure paste
the exact error (terminal + `~/Library/Application Support/main-launcher/logs/`).
Priorities, most important first:
1. `npm test` result + app boots without crashing (§1).
2. The raw backend commands in §2 (this is the core "does mac actually work").
3. FFmpeg resolves (§3).
4. Whatever §4 items the human could approve.

Anything that fails in §2 is a real bug to fix; anything blocked only by a
permission prompt in §4 is expected and just needs the human tap.
