# CLAUDE.md

## 1. Purpose

This repository contains **Launcher**, a Windows Electron-based desktop companion application.

Claude Code is responsible for:
- Producing production-ready, fully integrated code
- Preserving existing functionality unless explicitly told otherwise
- Implementing complete features (no partial or placeholder implementations)
- Ensuring system stability, performance, and maintainability

---

## 2. Project Overview

### Application: Main

Main is an always-on Electron desktop overlay (Windows) designed for gaming and power users.

### Core Features
- Spotify integration (PKCE OAuth, Web API)
- Live synced lyrics (lrclib.net, LRC-based)
- System performance monitoring (CPU, RAM, FPS)
- FPS optimization engine (Windows system tweaks)
- Quick Notes (persistent local storage)
- App launcher (custom executables + icons)
- Weather widget (wttr.in + geolocation)
- Global hotkeys (system-wide media control)
- System tray background operation
- Fully animated glass-morphism UI

---

## 3. Core Principles

- Never remove existing functionality unless required
- No partial or placeholder features
- Production-level quality on every change
- Preserve architecture and IPC boundaries
- Ensure full integration and stability

---

## 4. Development Rules

Before changes:
- Understand full system impact
- Ask clarifying questions if needed

During changes:
- Implement complete end-to-end features
- Handle edge cases and errors
- Maintain compatibility

After changes:
- Verify correctness
- Ensure no regressions

---

## 5. Versioning

- Patch: bug fixes
- Minor: new features
- Major: large refactors

Always:
- Update version
- Provide changelog
- List modified files

---

## 6. System Rules

Spotify:
- Preserve PKCE auth flow
- Safe token refresh logic

Lyrics:
- Maintain LRC timing accuracy
- Prevent race conditions

Performance:
- Accurate CPU/RAM calculations
- Stable FPS optimizer execution

UI:
- Preserve animations and layout stability
- Avoid flicker or layout jumps
- Tailwind is a static vendored build (`styles/vendor/tailwind.css`), not
  the CDN. Any new Tailwind class added in HTML or renderer JS requires
  `npm run build:css` and committing the regenerated file — otherwise the
  class silently does nothing at runtime.

Mini Widgets (Widget Library):
- `MINI_WIDGETS` in `renderer/core.js` is the single source of truth. To add
  a widget, add ONE registry entry (id, label, icon, description,
  longDescription, category, keywords, version, author, features, optional
  defaultHotkey, optional panelId + panelRenderer) plus the widget's own
  backend/renderer logic. The Widget Library, its search index, the
  dashboard Mini Widgets strip, and the Settings summary all generate from
  the registry — never hardcode widget lists in UI code.
- The full field reference is the comment block above `MINI_WIDGETS`.
- Config panels (`panelId`) are hosted in the library's detail view; their
  render functions must no-op when the panel div is absent
  (`if (!panel) return;`) because the div only exists while the detail is
  open.
- Enabled state lives in `miniWidgetPrefs`, favourites in `miniWidgetFavs`,
  recents in `miniWidgetRecents` (all localStorage; keep keys stable).

---

## 7. Data

Stored in %APPDATA%/main-launcher/
- Spotify tokens
- Settings JSON
- Cache files
- Logs

Never break compatibility.

---

## 8. Logging

All errors must go through Logger system.
No silent failures allowed.

---

## 9. General Rule

Every update must be production-ready, fully integrated, and stable.
