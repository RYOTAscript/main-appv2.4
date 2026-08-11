const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (callback) => ipcRenderer.on('mic-mute-overlay-state', (_event, muted) => callback(muted))
});
