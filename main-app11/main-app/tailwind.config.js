/**
 * Tailwind CSS build config — generates the vendored stylesheet at
 * styles/vendor/tailwind.css so the app never loads the Tailwind CDN.
 *
 * IMPORTANT: any new Tailwind class added in main.html, the overlay HTML
 * files, or any renderer/*.js template literal requires re-running:
 *
 *   npm run build:css
 *
 * and committing the regenerated styles/vendor/tailwind.css. Classes that
 * are not present in these files at build time will not exist at runtime.
 */
module.exports = {
    content: [
        './main.html',
        './mic-mute-overlay.html',
        './crosshair-overlay.html',
        './preload.js',
        './renderer/**/*.js',
    ],
    theme: {
        extend: {},
    },
    plugins: [],
};
