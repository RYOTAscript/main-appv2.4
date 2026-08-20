const path = require('path');

// Resolve the system-tray / menu-bar icon descriptor for the current OS.
//   • Windows: the existing multi-resolution .ico, passed straight to Tray().
//   • macOS: a PNG resized to the ~18px menu-bar height. Returned as `resize` so
//     the caller builds a nativeImage (a raw .ico string wouldn't render in the
//     mac menu bar). Colored for now — a monochrome `*Template.png` could later
//     replace it (set isTemplate:true) for a fully native menu-bar look.
// Pure (returns a descriptor, no electron), so it's unit-testable off-mac.
function resolveTrayIcon(platform, appRoot) {
  if (platform === 'darwin') {
    return { iconPath: path.join(appRoot, 'icons', 'logo.png'), resize: 18, isTemplate: false };
  }
  return { iconPath: path.join(appRoot, 'icons', 'main.ico'), resize: null, isTemplate: false };
}

module.exports = { resolveTrayIcon };
