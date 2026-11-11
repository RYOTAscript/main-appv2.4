// Minimal, isolated preload for the first-run welcome window (first-run.html).
//
// It used to load the main preload.js, which handed a welcome screen the entire
// `electronAPI` surface — every feature channel in the app — to render four
// lines of text and a button. Every other auxiliary window here (license gate,
// crosshair, mic-mute, area-select, voice overlay) gets a bridge scoped to what
// it actually does, and this is that bridge.
//
// Note what is NOT here: there is no openExternal. The page cannot name a URL.
// It can ask for "terms" or "privacy" and main decides what those resolve to
// (see main/firstRun.js), so the worst a compromised welcome page could do is
// open one of two pages on our own site.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('firstRun', {
  // The only state it reads.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getFocusHotkey: () => ipcRenderer.invoke('get-focus-hotkey'),

  // The only two things it can do.
  openLegal: (which) => ipcRenderer.invoke('first-run:open-legal', which),
  done: () => ipcRenderer.invoke('first-run-done'),
});
