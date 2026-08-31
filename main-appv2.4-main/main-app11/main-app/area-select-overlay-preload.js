const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the screen area / colour picker overlay (main/areaSelect.js).
// Deliberately tiny: the overlay receives one init payload and answers once.
contextBridge.exposeInMainWorld('areaSelectAPI', {
  onInit: (callback) => ipcRenderer.on('area-select:init', (_event, payload) => callback(payload)),
  submitArea: (rect) => ipcRenderer.send('area-select:result', { kind: 'area', rect }),
  submitColor: (color) => ipcRenderer.send('area-select:result', { kind: 'color', color }),
  submitPoint: (point) => ipcRenderer.send('area-select:result', { kind: 'point', point }),
  cancel: () => ipcRenderer.send('area-select:cancel')
});
