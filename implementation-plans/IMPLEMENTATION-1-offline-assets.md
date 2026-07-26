# IMPLEMENTATION 1 — Fully Offline App (bundle Tailwind + Font Awesome locally)

> **How to use this file:** paste the whole file as a prompt. It is a complete,
> self-contained work order for the Launcher app in `main-app11/main-app`.

## Goal

The app currently loads its two most critical UI resources from the internet on
every launch (`main.html` lines 8–9):

```html
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
```

If the network is down, slow, or blocked at startup, the entire app renders as
unstyled text and every icon (weather, Spotify controls, settings cog, mini
widgets) becomes an empty box. The Tailwind CDN script is also the *runtime JIT
compiler* — it re-generates all CSS in the renderer on every single launch,
which is explicitly not recommended for production and wastes CPU at startup.

**Deliverable:** the app must render pixel-identically with the network cable
unplugged, with zero CDN requests, and start faster than before. This is a
reliability fix → **patch or minor version bump** (recommend minor, since the
asset pipeline is new).

## Constraints (from CLAUDE.md — non-negotiable)

- No functionality may be lost: every Tailwind utility class used anywhere in
  the app must still resolve, and every Font Awesome icon must still render.
- No placeholder work: do not leave the CDN tags in as a "fallback".
- All errors through the Logger; no silent failures.
- Update version + CHANGELOG.md + list modified files when done.

---

## Phase 1 — Audit every consumer of the CDN assets

1. Enumerate all HTML entry points: `main.html`, `mic-mute-overlay.html`,
   `crosshair-overlay.html`, and anything under `fps-optimizer-electron/`.
   For each, record whether it references the Tailwind CDN, the Font Awesome
   CDN, or both.
2. Build the complete inventory of Tailwind classes actually used. They appear
   in three places, and **all three must be scanned**:
   - static `class="..."` attributes in the HTML files;
   - template literals in renderer JS (`renderer/*.js` builds large chunks of
     UI via `innerHTML` — e.g. `widgets-settings.js`, `macros.js`,
     `clipboard.js`, `spotify-enhanced.js`, `bluetooth.js`,
     `screen-resolution.js`, `video-editor.js`, `crosshair.js`);
   - classes toggled at runtime via `classList.add/remove/toggle`.
3. Grep for every `fa-`, `fas`, `far`, `fab` icon class the same way; note that
   `renderer/clock-weather.js` assigns icon classes dynamically from an
   `iconMap` — those strings must survive.
4. Check whether any code relies on the Tailwind CDN's runtime `tailwind.config`
   object or arbitrary-value classes (e.g. `w-[920px]`, `z-[70]`,
   `text-[10px]`, `h-[7.5rem]`) — `main.html` uses many; a static build must
   support all of them.
5. Record the current startup timing baseline (time from `npm start` to first
   paint, visible in the logger's startup lines) so Phase 6 can prove the
   improvement.

## Phase 2 — Decide the vendoring strategy

1. **Tailwind:** generate a static CSS file once at development time with the
   Tailwind CLI (standalone binary or `npx tailwindcss`), using a
   `tailwind.config.js` whose `content` globs cover `main.html`, the two
   overlay HTML files, and `renderer/**/*.js` (so classes inside JS template
   literals are picked up). Output to `styles/vendor/tailwind.css`, minified.
   The generated file is **committed to the repo** — end users never run a
   build step (the app ships as a portable exe and runs with `npm start` in
   dev).
2. **Font Awesome:** download the Font Awesome 6.5.1 **free** web package;
   copy `css/all.min.css` plus the `webfonts/` folder into
   `styles/vendor/fontawesome/`. Keep the exact same version (6.5.1) so no
   icon names shift. Verify the CSS's relative `../webfonts/` paths match the
   folder layout chosen.
3. Decide and document where vendored files live:
   `styles/vendor/tailwind.css`, `styles/vendor/fontawesome/css/all.min.css`,
   `styles/vendor/fontawesome/webfonts/*`.
4. Confirm licensing is fine (MIT for Tailwind output, Font Awesome Free
   license permits bundling) and note it in a small
   `styles/vendor/README.md`.

## Phase 3 — Generate and vendor the assets

1. Add `tailwind.config.js` at the app root (`main-app11/main-app/`) with the
   content globs from Phase 2 and no plugins. Add a dev-only npm script
   `"build:css"` to `package.json` that regenerates
   `styles/vendor/tailwind.css`. Tailwind CLI goes in `devDependencies` only —
   it must not ship in the packaged app.
2. Run the build; verify the output CSS contains representative classes from
   each category found in Phase 1, **including arbitrary-value classes**
   (`w-[920px]`, `text-[9px]`, `z-[70]`, `rounded-[32px]`) and classes that
   only exist inside JS template literals.
3. Download and place the Font Awesome files; verify the five font files
   (`fa-solid-900.woff2`, `fa-brands-400.woff2`, etc.) load from disk.
4. Add a comment header to the vendored Tailwind file stating it is generated,
   with the regeneration command.

## Phase 4 — Swap the references in every HTML entry point

1. In `main.html`, `mic-mute-overlay.html`, and `crosshair-overlay.html` (where
   applicable), replace the two CDN references with:
   ```html
   <link rel="stylesheet" href="styles/vendor/tailwind.css">
   <link rel="stylesheet" href="styles/vendor/fontawesome/css/all.min.css">
   ```
   Keep the load order: vendor CSS first, then `styles/main.css` and
   `styles/backgrounds.css`, so existing overrides keep winning.
2. Remove the CDN `<script src="https://cdn.tailwindcss.com">` entirely — with
   a static build there is no runtime compiler to load. Search the whole app
   for any other reference to `cdn.tailwindcss.com` or `cdnjs.cloudflare.com`
   and eliminate them.
3. Update `package.json` `build.files` so `styles/vendor/**/*` is included in
   the packaged build (the `styles/**/*` glob should already cover it —
   verify, don't assume).
4. If the app has a Content-Security-Policy or `session` request filtering in
   `main.js`, tighten it: with no CDN needs, remote stylesheet/script origins
   can be dropped.

## Phase 5 — Edge cases and hardening

1. **Overlay windows:** the mic-mute and crosshair overlays are separate
   BrowserWindows; confirm each one's HTML actually renders its icons/styles
   offline (they may have their own inline styles — verify rather than assume).
2. **FOUC check:** the CDN JIT compiler previously generated styles *after*
   script evaluation; a static stylesheet applies earlier. Verify the
   `fade-in` / `reveal-item` intro animations in `main.html` still fire
   correctly and nothing double-animates or flashes unstyled.
3. **Class coverage safety net:** add a short note to `CLAUDE.md` (or a
   comment in `tailwind.config.js`) that any new Tailwind class added in HTML
   or JS requires re-running `npm run build:css`. This is the one real
   maintenance cost of the change — make it loud.
4. **Font loading:** confirm `font-display` behavior doesn't briefly render
   tofu boxes for icons; Font Awesome's shipped CSS handles this, but verify
   on a cold start.
5. Do not delete anything from `node_modules` logic or touch the ffmpeg-static
   asar-unpack config while editing `build.files`.

## Phase 6 — Verification, versioning, changelog

1. **The offline test is the acceptance test:** disable Wi-Fi/Ethernet
   (or launch with the network adapter disabled), run `npm start`, and confirm
   the app is pixel-identical: glass panels, glow, all icons, weather icon
   placeholder, Spotify widget, settings modal, mini-widget panels, crosshair
   overlay, mic-mute overlay.
2. With DevTools → Network, confirm **zero** requests to any CDN on startup
   (weather/Spotify/lyrics requests are expected and unrelated).
3. Compare startup timing against the Phase 1 baseline; note the improvement.
4. Exercise dynamically-built UI: open Settings, every mini-widget panel,
   the FPS optimizer modal, and the lyrics modal — these are where a missed
   template-literal class would show up as broken layout.
5. Bump the version in **all four places** (`package.json`,
   `main.js` `APP_VERSION`, `main.html` header + footer version strings,
   `renderer/core.js`), add a CHANGELOG.md entry describing the change in
   user terms ("app now works fully offline and starts faster"), and list
   every modified file.
