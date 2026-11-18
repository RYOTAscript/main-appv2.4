# Vendored assets (committed — no build step for end users)

These files replace the Tailwind, Font Awesome, and Google Fonts CDN
references that the app used to load from the internet on every launch.
The app now renders fully offline with zero CDN requests.

## tailwind.css

Static Tailwind CSS 3.4.17 build, generated from the classes actually used in
`main.html`, the overlay HTML files, and `renderer/**/*.js` (see
`tailwind.config.js` at the app root).

**Regenerate after adding any new Tailwind class anywhere in HTML or renderer
JS** (classes not present at build time will not exist at runtime):

```
npm run build:css
```

License: generated output; Tailwind CSS itself is MIT licensed
(© Tailwind Labs Inc.).

## fontawesome/

Font Awesome Free 6.5.1 (`css/all.min.css` + `webfonts/`), unmodified, same
version the CDN previously served so no icon names shift.

License: see `fontawesome/LICENSE.txt` — Font Awesome Free
(icons CC BY 4.0, fonts SIL OFL 1.1, CSS MIT). Bundling is permitted.

## fonts/

Inter (300–700) and JetBrains Mono (400, 500) woff2 files, latin +
latin-ext subsets, previously loaded via an `@import` of
fonts.googleapis.com in `styles/main.css` (now `vendor/fonts/fonts.css`).

License: both families are SIL Open Font License 1.1. Bundling is
permitted.

## katex/

KaTeX 0.16.29 (`katex.min.js`, `katex.min.css`, the woff2 fonts only — the
stylesheet lists woff2 first and Chromium never requests the woff/ttf
fallbacks) plus `contrib/mhchem.min.js` for chemical equations, unmodified,
from the npm package. Used by the Study widget (formula overlays): the overlay
page loads it with plain script tags; the main window loads it on demand from
`renderer/study.js`.

License: KaTeX is MIT (`katex/LICENSE`); mhchem is Apache-2.0 (header in the
file). Both are listed in THIRD-PARTY-NOTICES.txt. Bundling is permitted.
