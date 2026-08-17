# CLAUDE.md

> The authoritative guidance now lives in the **repo-root `CLAUDE.md`**
> (`../CLAUDE.md`), which covers all three apps (desktop app, ValClips, website).
> That is the file Claude Code auto-loads. Edit it, not this one.

This directory is the **desktop app + ValClips** half of the monorepo:

- Desktop app (Main): `main-app11/main-app/` — Electron overlay. Entry `main.js`,
  bridge `preload.js`, renderer bootstrap + `MINI_WIDGETS` registry in
  `main-app11/main-app/renderer/core.js`.
- ValClips Quality: `valclips-quality/` — standalone electron-vite/React clip tool.

See `../CLAUDE.md` §2, §3, §6, and §7 for architecture, commands, gotchas,
testing workflow, and coupling hotspots.
