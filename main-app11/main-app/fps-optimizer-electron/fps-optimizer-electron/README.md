# FPS Optimizer — Electron Edition

This is the full Electron replacement for your Python `fps_optimizer_12.py` app. Same features, better UI, easier to build and distribute.

---

## What Changed?

| Old (Python) | New (Electron) |
|-------------|----------------|
| Tkinter UI (ugly, hard to theme) | HTML/CSS (glassmorphism, 60fps animations) |
| Single 2,000-line file | Clean split: backend + frontend + overlay |
| `psutil` dependency + manual `wmic` fallbacks | `systeminformation` npm package (cleaner) |
| Manual file-based logging | Built-in DevTools console + live log panel |
| No way to build an installer | `electron-builder` makes `.exe` installer automatically |

---

## Project Structure

```
fps-optimizer-electron/
├── main.js              ← All Windows system commands (powercfg, reg, taskkill, etc.)
├── preload.js           ← Safe bridge between main and UI
├── package.json         ← App config + dependencies
├── icon.ico             ← Your app icon (copied from old project)
├── src/
│   ├── index.html       ← Main dashboard UI (all pages)
│   ├── renderer.js      ← Frontend logic, sparklines, navigation
│   ├── styles.css       ← Dark glassmorphism theme
│   ├── overlay.html     ← Always-on-top FPS HUD
│   └── overlay.css      ← Overlay styles
```

---

## Setup (One-Time)

**Step 1 — Install Node.js**

If you don't have Node.js installed, download and install it from:
👉 https://nodejs.org/ (get the **LTS** version, the big green button)

**Step 2 — Open Terminal in this folder**

1. Navigate to `C:\Users\ivanq\Documents\fps optimizer\fps-optimizer-electron`
2. Click the address bar at the top, type `cmd`, press Enter

**Step 3 — Install dependencies**

Copy-paste this and press Enter:

```bash
npm install
```

This downloads Electron and `systeminformation`. It takes ~1 minute.

---

## Run (Development)

In the same terminal, run:

```bash
npm start
```

The app opens. It already requests **Administrator** rights (set in `package.json`).

---

## Build an Installer (.exe)

To create a proper Windows installer you can share or run anywhere:

```bash
npm run build-win
```

After it finishes, your installer is in:

```
dist/FPS Optimizer Setup.exe
```

Just double-click that `.exe` to install it like a normal Windows app. It will auto-request admin rights when launched.

---

## Features (Same as Python App)

| Page | What it does |
|------|-------------|
| **Dashboard** | Live CPU/GPU/RAM/Disk sparklines, quick actions (Optimise Only / Run All / Discord Only / Nuke), FPS overlay toggle, system readiness check, boost results |
| **Gaming** | Kill background apps, Discord-only mode, nuke everything, Game Mode toggle |
| **Power** | Ultimate / High / Balanced power plans, CPU priority for games, HAGS toggle |
| **Memory** | Clear standby RAM, wipe temp files, disable/enable Superfetch |
| **Network** | Flush DNS, low-latency network tweaks, reset to defaults |
| **Battery** | Full battery saver mode (CPU 50%, disable BT, kill non-Teams apps, etc.) + revert |
| **Restore** | One-click revert for visual effects, mouse, Game Bar, search, Superfetch, power, network |
| **Activity** | Live log of everything the app does |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Shift + F` | Toggle FPS overlay (to be added in future update) |

---

## Troubleshooting

**App says "Administrative Privileges required"**
→ This is normal. The app needs admin rights to modify registry and stop services. Right-click the `.exe` and choose **Run as administrator**.

**`npm install` fails**
→ Make sure you installed Node.js from the link above. Restart your terminal after installing.

**Overlay doesn't show**
→ The overlay is a separate window. If it's behind other windows, click the main app's **FPS Overlay** button again.

---

## Differences from Python Version

1. **No Python required** — Everything is JavaScript/Node.js.
2. **No `psutil` crashes** — Uses native Node.js system information.
3. **Better FPS estimate** — Weights GPU 40%, CPU 30%, Disk 20%, RAM 10% (not just GPU+CPU average).
4. **Cleaner UI** — Native HTML/CSS instead of tkinter canvas drawing.
5. **Real installer** — Build a `.exe` with one command.

---

## If Something Breaks

You still have your original `fps_optimizer_12.py` in the parent folder. The Electron app is completely separate — nothing is deleted or overwritten.

