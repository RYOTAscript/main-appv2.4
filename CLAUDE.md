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

There is also a nested helper Electron app, **fps-optimizer-electron**
(`main-app11/main-app/fps-optimizer-electron/`), spawned by Main via IPC.

The desktop app and website share a version number (currently **3.48.0**);
ValClips versions independently (**1.2.0**).

---

## 2. Desktop app (Main) — the primary codebase

Windows-only, always-on Electron overlay for gamers/power users. Glass-morphism
UI, system tray background operation.

### Entry points & process model
- **Main process:** `main.js` (~665 lines) — window/tray/IPC setup. Feature
  logic lives in `main/*.js` modules (one per feature: `spotify.js`,
  `fileSearch.js`, `controllerMacros.js`, …).
- **Preload:** `preload.js` — the **only** bridge. Exposes `window.electronAPI`
  via `contextBridge`. Context isolation is on; the renderer has no direct Node
  access. Add a method here to expose new main-process capability.
- **Renderer:** `main.html` + `renderer/core.js` (bootstrap) + one
  `renderer/<feature>.js` per feature (~35 files). Vanilla JS, no framework.

### IPC pattern (follow it exactly)
Renderer → `window.electronAPI.someCall()` (in `preload.js`) →
`ipcRenderer.invoke('channel', …)` → `ipcMain.handle('channel', …)` in the
feature's `main/*.js`. ~26 main modules register handlers. Never reach around
the preload bridge; never enable `nodeIntegration` in the renderer.

### Mini-Widget registry — single source of truth
`MINI_WIDGETS` in **`renderer/core.js`** is the one registry for all Launcher
mini widgets. To add a widget:
1. Add **one** registry entry (id, label, icon, description, longDescription,
   category, keywords, version, author, features, optional `defaultHotkey`,
   optional `panelId` + `panelRenderer`). The full field reference is the
   comment block directly above `MINI_WIDGETS`.
2. Add the widget's own `renderer/<id>.js` and, if it needs OS/privileged work,
   `main/<id>.js` + a `preload.js` method.
3. Add any Tailwind classes → **rebuild CSS** (see gotchas).

The Widget Library, its search index, the dashboard Mini Widgets strip, and the
Settings summary **all generate from this registry** — never hardcode widget
lists in UI code. Config panels (`panelId`) render inside the library detail
view and must no-op when their div is absent (`if (!panel) return;`) — the div
only exists while the detail is open. Enabled state → `miniWidgetPrefs`,
favourites → `miniWidgetFavs`, recents → `miniWidgetRecents` (all localStorage;
keep keys stable).

### Commands (run from `main-appv2.4-main/main-app11/main-app/`)
```bash
npm start            # electron . — run the app in dev
npm run build:css    # REQUIRED after adding/removing any Tailwind class
npm run build        # electron-builder --win → NSIS installer + portable exe
```
There is **no automated test suite** for the desktop app (`npm test` is a stub).
See §6 for how this app is actually tested.

### Runtime data
Stored under `%APPDATA%/main-launcher/`: Spotify tokens, settings JSON, caches,
logs, custom icons/backgrounds, `license.json`. **Never break the shape of
persisted data or localStorage keys** without a migration — users have live
state.

### Gotchas (these bite silently)
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
  adapter. Models in `prisma/schema.prisma` (User/Account/Session/License/
  Purchase).
- **DB:** **Postgres in every environment** (SQLite breaks on Vercel's
  ephemeral FS — see the schema comment). `DATABASE_URL` must be a hosted
  Postgres. `prisma/dev.db` is a local artifact and gitignored.
- **Commerce:** PayPal checkout (`src/lib/paypal.ts`), license provisioning
  (`src/lib/provision.ts`, `src/lib/license.ts`), product config
  (`src/lib/product.ts`).
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
- **Env:** never commit `.env*` (gitignored). Needs `DATABASE_URL`, Google OAuth
  creds, NextAuth secret, PayPal creds. Keep a `.env.example` in sync when you
  add a new required var.

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
