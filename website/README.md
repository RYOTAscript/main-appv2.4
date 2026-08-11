# main — website

The marketing + commerce site for **main**, a glass-morphism Windows desktop
overlay (v3.40.0, made by ryota). It sells the app as a **one-time $5 lifetime
license**, signs people in with **Google**, and — after a **PayPal** payment —
hands out a **license key** and a gated **Windows download**.

The whole site is deliberately built to feel like the same product as the app:
the design tokens (glass, glow, accent system, background FX, keyframes) are
lifted straight from the desktop app's stylesheet.

---

## Tech stack

- **Next.js 14 (App Router)** + **TypeScript** + **React 18**
- **Tailwind CSS** (custom design tokens) + a little hand-written CSS in
  `globals.css` for effects Tailwind can't express (glass blur, glow shadows,
  animated background layers, keyframes)
- **NextAuth (Auth.js) v4** with the **Google** provider
- **Prisma** + SQLite (local) / Postgres (production)
- **PayPal** Orders v2 (Smart Buttons) + a signature-verified webhook
- **Font Awesome** (self-hosted in `public/`) + **Inter** / **JetBrains Mono**
  via `next/font`

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env        # then fill in the values (see below)

# 3. Create the local database
npm run db:migrate          # applies migrations to the SQLite dev.db

# 4. Run
npm run dev                 # http://localhost:3000
```

The app runs with placeholder credentials, but **Google sign-in** and **PayPal
checkout** only complete once you add real keys.

---

## Environment variables

Every variable lives in `.env.example`. The important ones:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | SQLite file locally (`file:./dev.db`) or a Postgres URL in prod |
| `NEXTAUTH_SECRET` | Random string — `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Site URL (`http://localhost:3000` in dev) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials (web) |
| `GOOGLE_DESKTOP_CLIENT_ID` | Google OAuth client id (desktop) for in-app sign-in |
| `PAYPAL_ENV` | `sandbox` while testing, `live` for real money |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal REST app credentials |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Same as `PAYPAL_CLIENT_ID` — for the browser button |
| `PAYPAL_WEBHOOK_ID` | _(optional)_ Webhook id, to verify webhook authenticity |
| `DOWNLOAD_URL` | The Windows installer the gated `/download` page serves |
| `LICENSE_VERIFY_SECRET` | _(optional)_ shared secret to protect the verify API |

---

## Google OAuth setup

1. Go to the [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Configure the **OAuth consent screen** (External is fine for testing; add
   yourself as a test user).
3. Create an **OAuth client ID** → *Web application*.
4. Add the **Authorized redirect URI**:
   ```
   http://localhost:3000/api/auth/callback/google
   ```
   (and your production URL's equivalent once deployed).
5. Copy the **Client ID** and **Client secret** into `.env`.

---

## PayPal setup

1. Create/upgrade a **PayPal Business** account so you can receive payments.
2. At the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications)
   (toggle **Sandbox** while testing), **Create App** → copy the **Client ID**
   and **Secret** into `.env` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and
   `NEXT_PUBLIC_PAYPAL_CLIENT_ID` = the same client id). Keep `PAYPAL_ENV=sandbox`
   until you're ready for real money, then create a **Live** app and flip to
   `live`.
3. Test with a **Sandbox** buyer account (Developer Dashboard → Testing Tools →
   Sandbox Accounts): sign in → click the **PayPal** button → pay with the
   sandbox buyer. The order is created + captured server-side, your license is
   provisioned, and `/account` + `/download` unlock.
4. _(Optional, recommended for production)_ Add a **Webhook** in your app
   pointing at `https://your-domain/api/paypal/webhook`, subscribe to
   `PAYMENT.CAPTURE.COMPLETED`, and put the **Webhook ID** in `PAYPAL_WEBHOOK_ID`.
   It's a backup that provisions the license even if the buyer closes the tab
   right after approving.

### How the commerce flow works

1. User signs in with Google → a `User` row exists.
2. The **PayPal button** calls `POST /api/paypal/create-order`, which creates a
   $5 order tagged with the user id (`reference_id` / `custom_id`).
3. On approval, `POST /api/paypal/capture-order` captures the payment
   **server-side**, then records a `Purchase` and provisions a unique `License`
   (`MAIN-XXXX-XXXX-XXXX-XXXX`). It's **idempotent** — keyed by the PayPal order
   id, so a retry or a later webhook never double-provisions, and there's at most
   one active license per user.
4. `POST /api/paypal/webhook` (if configured) is a backup provisioning path for
   the same event, verified against PayPal.
5. `/account`, `/download`, and the pricing CTA read license status
   **server-side** — the client is never trusted.

### License verification API

The desktop app can validate a key online. Prefer POST for the verification
request:

```
POST /api/license/verify
Content-Type: application/json
Authorization: Bearer <secret>

{ "key": "MAIN-XXXX-XXXX-XXXX-XXXX" }
```

Response:

```json
{ "valid": true }
```

When `LICENSE_VERIFY_SECRET` is set, the endpoint requires the bearer token and
returns only `{ valid: true }` unless the request is authorized.

### Desktop app sign-in (native Google OAuth)

Buyers can sign into the **desktop app** with the same Google account they
bought with — no key to copy. The app runs its own Google OAuth (PKCE + loopback)
and posts the `id_token` to:

```
POST /api/app/session   { "idToken": "<google id_token>" }
→ { authenticated, email, name, picture, purchased, license: { key, issuedAt } | null }
```

The endpoint verifies the token against Google and the allowed audiences
(`GOOGLE_DESKTOP_CLIENT_ID` + `GOOGLE_CLIENT_ID`) and returns the account's
license. Full setup + the drop-in Electron code is in
[`docs/DESKTOP_APP_AUTH.md`](docs/DESKTOP_APP_AUTH.md). You'll need a **Desktop
app** OAuth client id in the same Google project → `GOOGLE_DESKTOP_CLIENT_ID`.

---

## Database — Postgres

The app uses **Postgres** in every environment (SQLite can't run on Vercel's
ephemeral filesystem).

1. Create a hosted Postgres — **Neon**, **Vercel Postgres**, or **Supabase**
   (all have free tiers). Vercel: Project → **Storage → Create Database →
   Postgres**.
2. Set **`DATABASE_URL`** to its connection string. Use the **non-pooling /
   direct** URL so migrations work (pgbouncer-pooled URLs can't run migrations).
3. Migrations apply automatically on deploy — the `build` script runs
   `prisma migrate deploy`. Locally, run `npm run db:deploy` (or `db:migrate` to
   create new migrations).

Useful scripts: `npm run db:migrate`, `npm run db:deploy`, `npm run db:studio`.
For local dev, point `DATABASE_URL` at the same hosted Postgres (or a local one).

---

## Deploying to Vercel

1. Push the repo and import it into Vercel.
2. **Create a Postgres** (Storage tab) and make sure **`DATABASE_URL`** is set to
   its direct connection string.
3. Add the rest of the env vars from `.env.example`:
   - `NEXTAUTH_URL` = your deployed URL, `NEXTAUTH_SECRET` (a real random string)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
     `NEXT_PUBLIC_PAYPAL_CLIENT_ID`
   - `DOWNLOAD_URL`
4. In **Google Cloud → Credentials → your Web OAuth client**, add the redirect
   URI `https://YOUR-DOMAIN/api/auth/callback/google` and the origin
   `https://YOUR-DOMAIN`.
5. Redeploy. The build runs `prisma generate && prisma migrate deploy &&
   next build`, so the schema is created on first deploy.
6. For real money: create a **Live** PayPal app, set `PAYPAL_ENV=live` with live
   keys, and add a webhook at `https://YOUR-DOMAIN/api/paypal/webhook`
   (`PAYMENT.CAPTURE.COMPLETED`) → `PAYPAL_WEBHOOK_ID`.

---

## Design notes — the accent system

The single most important design idea, borrowed straight from the app: **one CSS
variable re-tints the entire site.**

```css
:root {
  --accent: 255, 255, 255;   /* bare R, G, B — for rgba(var(--accent), …) */
  --accent-solid: #ffffff;   /* the same color as a value */
}
```

Every glow surface — the window halo (`.glow` / `.glow-strong`), performance
bars, iOS toggles, progress fills, nav underline, focus rings, card hovers —
references `var(--accent)` instead of a hardcoded color. So changing those two
variables recolors everything at once, with a smooth transition rather than a
snap.

`AccentProvider` (`src/components/AccentProvider.tsx`) writes the variables onto
`:root` and persists the choice to `localStorage`; the **accent picker** in the
footer and on `/account` is the exact same mechanism as the app's "Accent
theme" feature. Default is white, so the site looks identical to a fresh app
install until you pick a color.

Other tokens (glass `rgba(8,8,8,.88)` + `blur(48px)`, the `fadeIn` /`modalPop`
keyframes, both easing curves, the drifting-blob / grid / scanline / grain
background stack) are copied from
`main-app11/main-app/styles/{main,backgrounds}.css` so the site and the app read
as one product.

> **Note on Font Awesome:** it's self-hosted from `public/fontawesome/` and
> loaded via a `<link>` in `layout.tsx` rather than a `node_modules` CSS import.
> Importing the scoped package's CSS makes Next emit a `@fortawesome` vendor
> chunk its fallback `_document.js` can't resolve under `next start`, which 500s
> every unmatched route. The `@fortawesome/fontawesome-free` package is a
> devDependency and is only the source for the copied assets.

---

## Project structure

```
src/
  app/
    page.tsx              # hero + features + widgets + pricing
    account/              # auth-gated dashboard
    download/             # auth + purchase-gated download
    signin/               # glass "Continue with Google" dialog
    terms/ · privacy/     # legal
    not-found.tsx         # custom glass 404
    api/
      auth/[...nextauth]/ # NextAuth handler
      paypal/             # create-order, capture-order, webhook (idempotent)
      license/verify/     # desktop-app key check
  components/             # NavBar, Footer, sections, UI primitives, …
  data/                   # typed features + 19 mini-widgets (mirrors the app)
  lib/                    # prisma, auth, paypal, provision, license helpers
prisma/schema.prisma      # User/Account/Session/VerificationToken + License/Purchase
```

Made by ryota · main v3.40.0
