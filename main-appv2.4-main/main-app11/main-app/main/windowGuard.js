// Navigation lockdown for every BrowserWindow this app creates.
//
// Every window here renders a local file:// page and never legitimately
// navigates away or opens a child window. The only outbound links go through
// the `open-external` IPC, which validates the scheme and hands the URL to the
// OS browser. So both are denied at the source:
//
//   • a window opened by page script inherits the opener's preload, and with it
//     that window's whole contextBridge surface, and
//   • an in-window navigation would swap our UI for someone else's document
//     inside a context that still holds that bridge.
//
// This runs in dev as well as in packaged builds — a guard that only exists in
// one of the two is a guard nobody notices breaking.
//
// The Spotify auth window is the deliberate exception: it has to navigate to
// accounts.spotify.com and back to the loopback redirect, so it keeps its own
// will-navigate/will-redirect handlers in main/spotify.js and must NOT be
// passed through here.

function lockNavigation(win, logger) {
  if (!win) return;
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    logger?.warn?.('Blocked window.open from renderer', { url: String(url).slice(0, 200) });
    return { action: 'deny' };
  });

  const blockNavigation = (event, url) => {
    // Navigating to the URL already loaded is what a reload does; allow it and
    // block everything else, which is either an attack or a bug.
    if (url === wc.getURL()) return;
    event.preventDefault();
    logger?.warn?.('Blocked in-window navigation', { url: String(url).slice(0, 200) });
  };

  wc.on('will-navigate', blockNavigation);
  wc.on('will-redirect', blockNavigation);
}

module.exports = { lockNavigation };
