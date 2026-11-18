const { contextBridge, ipcRenderer } = require('electron');

// The drawing overlay's bridge. Deliberately narrow: it can fetch its start-up
// state, change its own tool settings, freeze or unfreeze the frame, switch
// click-through, save or copy what's drawn and close itself — nothing else.
// Main checks every message comes from the overlay window (main/screenDraw.js).
contextBridge.exposeInMainWorld('screenDraw', {
  ready: () => ipcRenderer.invoke('screen-draw:ready'),
  painted: () => ipcRenderer.send('screen-draw:painted'),
  close: () => ipcRenderer.send('screen-draw:close'),
  setPrefs: (patch) => ipcRenderer.send('screen-draw:prefs', patch),
  freeze: () => ipcRenderer.invoke('screen-draw:freeze'),
  unfreeze: () => ipcRenderer.send('screen-draw:unfreeze'),
  passThrough: (on) => ipcRenderer.send('screen-draw:pass-through', !!on),
  hoverUi: (over) => ipcRenderer.send('screen-draw:hover-ui', !!over),
  save: (payload) => ipcRenderer.invoke('screen-draw:save', payload),
  copy: (payload) => ipcRenderer.invoke('screen-draw:copy', payload),
  reveal: () => ipcRenderer.send('screen-draw:reveal'),
  onState: (callback) => ipcRenderer.on('screen-draw:state', (_event, state) => callback(state))
});
