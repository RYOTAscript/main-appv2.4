const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  onConfig: (callback) => ipcRenderer.on('crosshair-overlay-config', (_event, cfg) => callback(cfg))
});
