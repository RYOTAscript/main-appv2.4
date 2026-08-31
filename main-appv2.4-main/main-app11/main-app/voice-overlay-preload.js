const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the voice assistant overlay window (voice-overlay.html).
//
// Deliberately narrow: the overlay renders state and reports user gestures, and
// that is all. It never reaches a feature IPC channel directly — commands are
// dispatched by main/voiceAssistant.js to the main window's executor, so the
// overlay has no route to launch anything, and a compromised overlay page could
// do nothing but cancel itself.
contextBridge.exposeInMainWorld('voiceOverlay', {
  // main → overlay
  onState: (callback) => ipcRenderer.on('voice:overlay-state', (_event, payload) => callback(payload)),
  // Audio level from the recognizer host (0–100). Only used when the overlay's
  // own microphone analyser is unavailable — see the fallback in the render loop.
  onLevel: (callback) => ipcRenderer.on('voice:overlay-level', (_event, level) => callback(level)),

  // overlay → main
  ready: () => ipcRenderer.send('voice:overlay-ready'),
  // "A visible state is now on screen." Main holds the window back until this
  // arrives, so it can never be shown displaying the previous state's frame.
  painted: () => ipcRenderer.send('voice:overlay-painted'),
  cancel: () => ipcRenderer.send('voice:overlay-cancel'),
  listen: () => ipcRenderer.send('voice:overlay-listen'),
  choose: (commandId) => ipcRenderer.send('voice:overlay-choose', commandId),
  confirm: (answer) => ipcRenderer.send('voice:overlay-confirm', answer),
  submitText: (text) => ipcRenderer.send('voice:overlay-text', text),
  // The overlay window is click-through so it never blocks a game; it asks main
  // to stop ignoring the mouse only while the pointer is genuinely over the
  // capsule (the standard Electron forward-mouse pattern).
  setHover: (over) => ipcRenderer.send('voice:overlay-hover', !!over),
  // Reports whether the overlay could open a microphone for its visualisation,
  // so main can surface a real permission state instead of guessing.
  micState: (state, detail) => ipcRenderer.send('voice:overlay-mic-state', state, detail)
});
