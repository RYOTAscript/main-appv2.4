# Build Prompt — "main" retail website (for Claude Code, Opus 5)

> Paste everything below the line into a fresh **Claude Code (Opus 5)** session opened in this repo. It is self-contained: design tokens, page-by-page spec, feature copy, auth, and the $5 purchase flow are all included — but you also have the whole codebase and full tooling (read files, run the dev server, install deps, etc.), so use them.

---

## YOU HAVE THE APP'S SOURCE CODE — READ IT FIRST

You are Claude Code running in the same repo as the "main" desktop app, so you have **direct access to its real source files and full tooling**. Before writing a single line of the website, actually open and read these files and treat them as the ground truth for the look and feel — the tokens in this prompt are only a summary; the actual files are authoritative. In particular, study:

- `main-app11/main-app/main.html` — the real window layout, header, Quick Launch, the three widget cards, mini-widgets strip, Settings modal, Widget Library modal.
- `main-app11/main-app/styles/main.css` — the full design system (~3200 lines): `.glass`, `.glow`/`.glow-strong`, section labels, iOS toggles, vinyl/Spotify player, lyrics, hotkey pills, every keyframe and easing curve.
- `main-app11/main-app/styles/backgrounds.css` — the animated Background Studio layer stack (scenes, blobs, grid, scanlines, vignette, grain).
- `main-app11/main-app/renderer/core.js` — the `MINI_WIDGETS` registry (single source of truth for every mini widget: id, label, description, category, icon, features).
- `CLAUDE.md` — project overview and feature list.

Pull the **exact** colors, radii, blur values, shadow definitions, animation timings and easing curves from those files. If anything in this prompt disagrees with the actual code, the code wins. Copy the real keyframes rather than approximating them.

---

## BUILD WORKFLOW — 6 stages, gated by my approval

Build the site in the **6 stages** below, **in order**. This is a hard rule:

- After finishing each stage, **STOP**. Give me a short summary of what you did, how to see it working (e.g. what to run / what page to open), and what's next — then **wait for my approval**.
- When I reply **"go"**, proceed to the next stage only.
- When I reply **"auto"**, switch to autonomous mode: complete **all remaining stages back-to-back without stopping** until the whole site is finished, only pausing if you hit something that truly needs my decision (e.g. a missing credential you can't stub).
- If I give other feedback, apply it and re-confirm before advancing.
- Do not skip ahead or merge stages. Each stage should leave the project in a runnable, committed state.

**Stage 1 — Foundation & design system.** Scaffold the Next.js + TypeScript + Tailwind project. Read the app's real CSS and encode the design system: `tailwind.config.ts` (palette, fonts, radii), `globals.css` with the CSS variables, `.glass`/`.glow`/`.glow-strong`, section labels, iOS toggle, all keyframes/easings, and the animated background FX layers. Build the base shell: fonts (Inter + JetBrains Mono), Font Awesome, root layout, glass **NavBar** and **Footer**, and reusable primitives (`Button`, `GlassCard`, `SectionLabel`, `Toggle`, `HotkeyPill`, `BackgroundFX`). Deliverable: an empty dark page on the animated glass canvas that already looks like "main".

**Stage 2 — Landing hero.** Build `/` with the full animated **app-window mock** (faithful replica of the real window) as the centerpiece, headline, CTAs, and the load-in + living-hero animations from the ANIMATION section. Scroll-reveal wiring in place.

**Stage 3 — Features & Widget Library.** Build the `#features` grid (core features) and the searchable, category-filtered `#widgets` grid driven from a typed data array mirroring the real `MINI_WIDGETS` registry (all 19). Full hover/reveal animation.

**Stage 4 — Auth.** Add NextAuth with the Google provider, the glass "Continue with Google" sign-in modal (`modalPop`), session handling, and the auth-gated `/account` dashboard shell (avatar, name, email, sign-out, accent picker). Prisma schema + migrations for `User/Account/Session/VerificationToken`.

**Stage 5 — Commerce.** Add `License` + `Purchase` models, Stripe Checkout for the $5 product, the idempotent webhook that provisions a unique license key, server-side license status on `/account` + pricing CTA, the gated `/download` page, and the `GET /api/license/verify` route. Working end-to-end in Stripe test mode.

**Stage 6 — Polish & ship.** Full animation/micro-interaction pass, responsiveness down to mobile, accessibility + `prefers-reduced-motion`, Terms/Privacy pages, `.env.example`, `README.md` (Google + Stripe + DB setup, design notes), and a final QA pass against the app for visual fidelity.

---

## ROLE & GOAL

You are a senior full-stack product engineer and UI designer. Build, from scratch, a
**production-ready marketing + commerce website** for a Windows desktop app called
**"main"** (a glass-morphism gaming/power-user overlay, current version **v3.40.0**, "made by ryota").

The website has three jobs:

1. **Sell the app** as a **one-time $5.00 USD purchase per user** (lifetime license, single product).
2. Let people **create an account by signing in with Google** (Google OAuth — the primary/only sign-up method).
3. After purchase, give the buyer a **license key** and a **gated download** of the Windows installer.

**The single most important requirement: the website's visual design must feel like the same product as the app** — identical dark glass-morphism aesthetic, same colors, same typography, same glow, same motion. Treat the design tokens below as law. A visitor who has used the app should instantly recognize the website as "the same thing, on the web."

---

## TECH STACK (use exactly this unless you hit a hard blocker)

- **Next.js 14+ (App Router) + TypeScript + React**.
- **Tailwind CSS** for styling, extended with the custom design tokens below. Add small amounts of custom CSS (in `globals.css`) for effects Tailwind can't express (glass blur, glow shadows, animated background layers, keyframes).
- **NextAuth.js (Auth.js)** with the **Google provider** for authentication. Sessions via JWT or database sessions (your call), but persist users.
- **Prisma + a SQL database** (Postgres; use SQLite for local dev via an env switch). Models: `User`, `Account`, `Session`, `VerificationToken` (NextAuth), plus `License` and `Purchase`.
- **Stripe Checkout** (hosted) for the $5 payment, with a **Stripe webhook** that provisions the license on `checkout.session.completed`. Include a working test-mode setup.
- **Font Awesome** (free) for icons and **Inter** + **JetBrains Mono** web fonts — the app uses these exact fonts, so the site must too.
- Deployable to **Vercel**. Provide a `.env.example` listing every required variable (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `DOWNLOAD_URL`).

Everything must actually run. No placeholder TODOs in critical paths. Include a `README.md` with setup steps (Google OAuth consent screen, Stripe product/price/webhook, DB migrate, `npm run dev`).

---

## DESIGN SYSTEM — replicate the app exactly

These tokens are extracted verbatim from the app's stylesheet. Encode them as Tailwind theme extensions + CSS variables and use them everywhere.

### Color & surface
- **Page background:** near-black `#080808`, layered with soft radial light pools:
  `radial-gradient(ellipse 80% 60% at 50% 0%, rgba(255,255,255,0.06), transparent 60%)` +
  `radial-gradient(ellipse 50% 40% at 80% 100%, rgba(255,255,255,0.03), transparent 50%)` over `#080808`.
- **Glass panels/cards:** `background: rgba(8,8,8,0.88)` with `backdrop-filter: blur(48px)`. This is the `.glass` look — every card, modal, nav bar and pricing tile uses it.
- **Borders:** hairline `rgba(255,255,255,0.10)` (occasionally `0.12`).
- **Text hierarchy** (top → bottom prominence): pure white `#fff` for headings → `neutral-300` (`#d4d4d4`) → `neutral-400` → `neutral-500` (`#666`) for muted → `neutral-600`/`neutral-700` for the faintest labels/footers.
- **Accent system (critical):** the app tints its entire glow from CSS variables that **default to white**:
  ```css
  :root { --accent: 255, 255, 255; --accent-solid: #fff; --glow-strength: 0.12; --glow-spread: 40px; }
  ```
  `--accent` is bare `R, G, B` for use inside `rgba(var(--accent), …)`. Use this same pattern so a single variable change re-tints the whole site. Default accent = white. Provide a subtle **accent picker** in the footer or account page (a few swatches: white, cyan `#22d3ee`, violet `#a78bfa`, pink `#f472b6`, green `#1db954`) that live-updates `--accent`/`--accent-solid` — mirrors the app's "Accent theme" feature.

### Glow (signature effect — use on the main container and cards)
```css
.glow        { box-shadow: 0 0 var(--glow-spread) rgba(var(--accent), var(--glow-strength)),
                           inset 0 1px 0 rgba(255,255,255,0.06); }
.glow-strong { box-shadow: 0 0 calc(var(--glow-spread)*1.5) rgba(var(--accent), calc(var(--glow-strength)*1.8)),
                           0 0 80px rgba(var(--accent), calc(var(--glow-strength)*0.5)),
                           inset 0 1px 0 rgba(255,255,255,0.1); }
```

### Typography
- Body/UI: **Inter**, sans-serif.
- Numbers, code, hotkey pills, version strings, timestamps: **JetBrains Mono** (`tabular-nums`, `font-mono`).
- Big display lyrics-style headlines may use `-apple-system, 'SF Pro Display', 'Segoe UI'` with `letter-spacing: -0.3px` and `font-weight: 700`.
- **Section labels** (the app's signature small caps): `font-size: 0.7rem; letter-spacing: 0.2em; text-transform: uppercase; color: #666; font-weight: 500;`. Use these above every section ("FEATURES", "PRICING", "WIDGET LIBRARY", etc.).

### Shape & spacing
- Big surfaces use **very round corners**: main hero container `border-radius: 32px`; cards `rounded-3xl` (24px); buttons `rounded-2xl`/`rounded-xl`; small pills `rounded-lg`.
- Generous padding (`p-5`…`p-8`), roomy vertical rhythm.
- **Primary CTA button:** solid **white background, black text**, `rounded-2xl`, `font-medium`, hover → `neutral-200`. (e.g. "Buy now — $5", "Continue with Google", "Done".)
- **Secondary button:** transparent with `border border-white/12`, `bg-white/8`, hover `bg-white/15`, white text.
- **Ghost/window buttons:** 32px square, `rounded-[10px]`, `border rgba(255,255,255,0.12)`, `bg rgba(255,255,255,0.04)`, muted icon, hover brightens.

### Component motifs to reuse from the app
- **iOS-style toggle switches** for any on/off UI (feature filters, accent, theme).
- **Hotkey pills** rendered in JetBrains Mono inside a bordered `rounded-[10px]` chip — use these to show the app's global hotkeys in the feature section.
- **Progress bars:** 1px-to-2px tall track `bg-neutral-800 rounded-full`, fill = gradient `linear-gradient(90deg, var(--accent-solid), rgba(var(--accent),0.85))` with a soft accent glow. Reuse for any stat/step visuals.
- **Vinyl / disk imagery** and album-style rounded media for the Spotify feature block.

### Background layers & motion (build these as fixed, pointer-events-none layers behind content)
Recreate the app's animated "Background Studio" stack on the site's hero/landing:
1. `bg-scene` radial light pools over `#080808` (above).
2. **Drifting color blobs** — 3 large, heavily-blurred radial blobs slowly animating position/scale (use the accent + two complementary hues; keep them subtle at low opacity).
3. **Grid overlay:** `linear-gradient` 1px lines at `rgba(255,255,255,0.03)`, `background-size: 48px 48px`, masked with a radial `mask-image` so it fades at the edges, and animate a slow vertical `gridDrift` (translateY 0→48px over ~24s, linear infinite).
4. **Scanlines:** faint repeating horizontal lines `rgba(255,255,255,0.012)` every 4px.
5. **Vignette** and optional **film grain/noise** overlay.
Keep all of this GPU-cheap and respect `prefers-reduced-motion` (disable drifts/animations when set).

### Keyframes to include (match the app's easing)
- `fadeIn`: from `opacity:0; translateY(24px) scale(0.98)` → to `opacity:1; translateY(0) scale(1)`, `1s cubic-bezier(0.22,1,0.36,1)`. Use as a scroll-reveal for sections and cards (stagger with animation-delays like `0.08s, 0.16s, 0.24s…`, exactly as the app staggers `reveal-item`s).
- `modalPop`: `opacity:0; scale(0.82)` → `scale(1)`, `0.45s cubic-bezier(0.34,1.56,0.64,1)` — for modals/dialogs.
- `pulseGlow`, `ringSpin` — subtle looping accents (e.g. a spinning ring around a hero badge, a pulsing "live" dot).
- Card hover: `border-color: rgba(var(--accent),0.18); box-shadow: 0 0 30px rgba(var(--accent),0.06);` and icon tiles scale `1.12` + lift `-4px` on hover with a springy `cubic-bezier(0.34,1.56,0.64,1)`.

---

## SITE STRUCTURE (pages & routes)

Build a cohesive multi-section marketing site plus auth/commerce/account. Everything sits on the dark glass canvas described above; the top nav is a slim glass bar with the "main" wordmark (lowercase, `text-2xl font-semibold tracking-tight`) + a tiny mono `v3.40.0` under it, a nav link set, an accent/clock flourish on the right (optional live clock in JetBrains Mono to echo the app header), and a **"Sign in with Google"** / account button.

### 1. `/` — Landing / Hero
- Full-viewport hero on the animated background. A large rounded-32px glass "app window" mock floating center — **recreate a faithful, static (or lightly animated) replica of the app's actual window** as the hero image: header bar with the "main" logo + version + weather/clock chips + cog/minimize buttons; a "Quick Launch" row of rounded app-icon tiles; the three widget cards (**Quick Notes**, **Performance** with animated CPU/RAM bars, **Spotify** vinyl player with progress bar); and a "Mini Widgets" strip. This replica is the centerpiece — it must look pixel-close to the real app using the tokens above.
- Headline (white, tight tracking): something like **"Your desktop, glassed."** with a muted `neutral-400` subhead describing it as an always-on Windows overlay for gaming and power users.
- Primary CTA **"Get main — $5"** (white/black button) → pricing/checkout. Secondary **"See features"** ghost button scrolling down.
- A small mono line: "One-time payment · Lifetime license · Windows 10/11".

### 2. `#features` — Core features
Section label "FEATURES". A responsive grid of glass cards (glow on hover, staggered fadeIn). Cover the app's core:
- **Spotify integration** — PKCE OAuth player with vinyl disk, controls, volume, queue, beat-reactive glow, audio visualizer (circular/waveform/aura/particles).
- **Live synced lyrics** — LRC-timed lyrics that scroll in sync (from lrclib.net), with a full-screen lyrics view.
- **Performance monitoring** — live CPU / RAM / FPS with animated bars.
- **FPS Optimizer** — one-click Windows tweaks: Optimize, Discord-Only, Kill Everything, Battery Saver, Restore Defaults.
- **Quick Launch** — pin apps & games with custom icons; folders, profiles, auto-detect Steam/Epic games.
- **Quick Notes** — persistent local notes (tabs, checklists, markdown, history in the enhanced mode).
- **Weather & Clock** — header readout + 3-day forecast panel, °C/°F, 12/24h.
- **Global hotkeys** — system-wide media & app control; show them as JetBrains-Mono hotkey pills.
- **Background Studio** — animated scenes, your own image/GIF/video wallpaper, accent theming, blur/brightness/saturation, film grain, vignette, grid, scanlines; true frosted-glass transparent mode over your live desktop.
- **System tray / always-on overlay**, parallax depth effect, fully animated glass UI.

### 3. `#widgets` — The Widget Library
Section label "WIDGET LIBRARY". Reproduce the app's Widget Library feel: a searchable, category-filtered grid of mini-widget cards (each: icon tile, name, one-line description, a small category chip and an iOS toggle for flavor). Populate with the **19 real mini widgets** below (name — category — description):

1. **Mic Mute** — Audio — Mute your microphone system-wide with a hotkey, with an on-screen status overlay even outside the app.
2. **Macros** — Productivity — Record & replay mouse/keyboard actions system-wide; per-macro hotkeys with Pressed/Hold/Toggle/Released modes, repeat counts, playback speed.
3. **Controller Macros** — Gaming — Map controller inputs and stick movements to macros with a visual joystick editor.
4. **Clipboard History** — Clipboard — Running history of everything you copy (text, images, files) to re-copy, pin, or delete.
5. **Spotify Enhanced** — Spotify — Queue viewer, playlist shortcuts, recently played, one-click like/unlike on the player.
6. **Screen Resolution** — Displays — Detect & switch each monitor's resolution and refresh rate; favourites; auto-revert unsupported switches after 15s.
7. **Bluetooth Manager** — System — Full Bluetooth control centre: toggle the radio, see paired devices with battery/status, connect/disconnect/remove, scan & pair, favourites, auto-reconnect.
8. **Claude Limit Auto-Continue** — Productivity — Auto-continues Claude when it hits usage limits.
9. **File Search** — Searching — Fast local file search.
10. **Video Editor** — Media — Fast video trimmer: set in/out points, keep/drop audio, lossless or frame-accurate export, bundled FFmpeg.
11. **ValClips Quality** — Media — TikTok/clip optimiser: size-cap default, chroma boost, own FFmpeg.
12. **Crosshair** — Gaming — Draws a customizable crosshair centered above every window; style, color, size, gap, opacity; hotkey toggle.
13. **Weather Enhanced** — Weather — Full detail panel: feels-like, humidity, wind, 3-day forecast; auto-location or pinned city.
14. **Countdown Timer** — Productivity — Presets or custom duration with header live readout, sound + toast on finish.
15. **Quick Notes Enhanced** — Productivity — Multi-note tabs, checklists, Markdown preview, per-note version history.
16. **Quick Launch Enhanced** — Utilities — Folders, auto-detect Steam/Epic games, multi-app launch profiles, running indicators.
17. **Game Mode** — Gaming — One-key gaming optimizations/overlay tuning.
18. **Volume Mixer** — Audio — Per-app volume mixer with master control and optional global hotkeys.
19. **Discord Rich Presence** — Social — Custom Discord Rich Presence card with images, buttons, elapsed clock, live preview.

Group them under category chips (Audio, Productivity, Gaming, Spotify, Media, System, Displays, Utilities, Social, Weather, Clipboard, Searching) and make the search box filter live.

### 4. `#pricing` — Pricing / Buy
Section label "PRICING". A single centered glass pricing card (`glow-strong`, modalPop on view):
- Big price: **$5** with a mono "one-time · lifetime" sub-line.
- Bullet list of what's included (all core features + all 19 mini widgets + free updates for v3.x + Windows 10/11).
- Primary white/black CTA:
  - If **signed out** → "Continue with Google to buy" (starts Google auth, then Stripe Checkout).
  - If **signed in but not purchased** → "Buy now — $5" → Stripe Checkout.
  - If **already purchased** → "Download for Windows" + shows the license key.
- Reassurance line: "Secure checkout by Stripe. Instant license & download."

### 5. Auth
- **Sign-in page/modal** styled as a glass `modalPop` dialog: "Welcome to main", a single big **"Continue with Google"** button (white/black, Google glyph), fine print linking Terms & Privacy. No email/password — Google only.
- After sign-in, return the user to where they were (checkout intent preserved).

### 6. `/account` (auth-gated) — Dashboard
Glass panel styled like the app's Settings modal (sticky search-less header "Account", saved-dot flourish). Shows:
- Google avatar + name + email.
- **License status**: Active / Not purchased. If active, show the **license key** in a mono pill with a copy button, purchase date, and a **"Download for Windows"** button (only enabled when purchased).
- **Buy** button if not purchased.
- Accent theme picker (re-tints the whole site) to echo the app.
- Sign-out (ghost button).

### 7. `/download` (auth + purchase-gated)
- If the user has a valid license → serve/redirect to the installer (`DOWNLOAD_URL`) and show the license key + basic install steps. If not purchased → redirect to pricing.

### 8. Footer
Slim, muted (`neutral-600`, mono flourishes): wordmark, "made by ryota", `v3.40.0`, links (Features, Widgets, Pricing, Terms, Privacy, Support), and the accent picker swatches. Echo the app's footer style ("made by ryota · v3.40.0").

### 9. Legal
Minimal but real **Terms** and **Privacy** pages (glass, readable, same type system). Cover: one-time license grant, single-user, refunds policy (state a simple one), Google data used only for auth, Stripe handles payment, no reselling.

---

## COMMERCE LOGIC (must actually work end-to-end in Stripe test mode)

1. User signs in with Google (NextAuth). A `User` row exists.
2. On "Buy" → create a **Stripe Checkout Session** (mode `payment`, the $5 `STRIPE_PRICE_ID`, `client_reference_id = user.id`, success/cancel URLs back to `/account`).
3. **Webhook** `/api/stripe/webhook` verifies the signature; on `checkout.session.completed`:
   - Create a `Purchase` (Stripe session id, amount, timestamp) linked to the user.
   - Generate a unique **license key** (format e.g. `MAIN-XXXX-XXXX-XXXX-XXXX`, cryptographically random, stored on a `License` row, one active license per user) — do not duplicate on webhook retries (idempotent by session id).
4. `/account`, `/download`, and the pricing CTA read license status server-side (never trust the client).
5. Provide an **API route** `GET /api/license/verify?key=…` returning `{ valid, email, issuedAt }` — so the **desktop app could validate a key online** later. Simple bearer-less lookup is fine for now; note in README where to add a shared secret.

---

## ANIMATION — this must feel alive (high priority)

Motion is a core part of what makes the app feel premium, and the website must match that energy. Do **not** ship a static page with a couple of fades. Aim for tasteful, high-craft motion everywhere, using the app's own easing curves (`cubic-bezier(0.22,1,0.36,1)` for reveals/eases, `cubic-bezier(0.34,1.56,0.64,1)` for springy pops/hovers). Prefer GPU-friendly `transform`/`opacity`, keep it smooth (target 60fps), and gate all of it behind `prefers-reduced-motion`.

Deliver at least:

- **Scroll-reveal choreography** — sections and cards animate in on scroll with the app's `fadeIn` (rise + slight scale), **staggered** across children (`0.08s, 0.16s, 0.24s…`) exactly like the app's `reveal-item` delays. Use `IntersectionObserver`, animate once.
- **Living background** — the blobs continuously drift/scale, the grid slowly drifts vertically (`gridDrift`), scanlines/grain shimmer subtly. It should never look frozen.
- **Hero app-window mock that performs** — don't leave it static. On load it assembles (header, then Quick Launch tiles, then widget cards popping in with the springy easing). Keep it subtly alive after: the Performance CPU/RAM bars animate/breathe, the Spotify vinyl disk slowly spins with a beat-style glow pulse, the progress bar creeps, a "live" dot pulses. Optional light **pointer parallax** (background drifts away from the cursor, foreground tiles lean toward it) — mirror the app's parallax feature, and disable on touch/reduced-motion.
- **Rich hover states** — icon tiles scale `1.12` + lift `-4px` with the spring curve and gain an accent glow; cards raise their border/shadow to the accent tint; buttons have smooth press/hover transitions. Nothing should snap.
- **Animated numbers/bars** — count-up on stats when they scroll into view; progress/meter fills glide with the accent gradient + glow.
- **Micro-interactions** — accent swatch change smoothly re-tints the whole page (transition the glow/borders, not an instant swap); toggles slide like real iOS switches; copy-license button gives a quick confirmation pop; nav links get an animated accent underline.
- **Modal/route motion** — sign-in and any dialogs enter with `modalPop` (scale-up + fade) and exit cleanly; page/section transitions feel continuous, never a hard cut.
- **Signature loops** — reuse `pulseGlow` and `ringSpin` for accents (e.g. a spinning ring around the hero badge, pulsing status dots), matching the app.

Treat animation quality as a graded deliverable: if the page feels flat or abrupt anywhere, it's not done.

## QUALITY BAR

- **Pixel-faithful to the app.** Before finishing, re-check hero window, cards, buttons, toggles, section labels, glow and background layers against the tokens above.
- Fully **responsive** (desktop-first, but graceful down to mobile — the hero window scales/reflows, grids collapse to one column). Body must never scroll horizontally; wide elements scroll inside their own container.
- **Accessible:** semantic HTML, focus-visible rings (accent-tinted), `prefers-reduced-motion` disables drifts/parallax, sufficient contrast for muted text, alt text, keyboard-navigable nav/modals.
- **Dark theme only** (the app is dark-only) — commit fully to the dark glass look; do not build a light mode.
- Clean, typed, componentized code (`Button`, `GlassCard`, `SectionLabel`, `Toggle`, `HotkeyPill`, `AppWindowMock`, `BackgroundFX`, `PricingCard`, `WidgetCard`, `NavBar`, `Footer`). No dead code, no console spam.
- Include seed/mock data for the widgets and features as typed arrays so the grids render from data, not hardcoded markup.

## DELIVERABLES

1. The complete Next.js project (all routes, components, API routes, Prisma schema, migrations).
2. `globals.css` with the CSS variables, `.glass`/`.glow`/`.glow-strong`, section-label, toggle, background-layer and keyframe styles.
3. `tailwind.config.ts` extending the palette/fonts/radii.
4. `.env.example` and a `README.md` with exact setup for Google OAuth, Stripe (product/price/webhook via Stripe CLI), and DB migrate.
5. A short "Design notes" section in the README explaining how the accent-variable system re-tints the whole site (so it stays faithful to the app).

Build it now, end to end. Prioritize the visual fidelity to the app and a working Google-sign-in → $5 Stripe purchase → license + gated download flow.
