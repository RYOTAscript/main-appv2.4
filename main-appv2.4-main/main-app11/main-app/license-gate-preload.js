// Minimal, isolated preload for the license gate window. Exposes only the
// license IPC — none of the main app's API is available here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseGate', {
  getState: () => ipcRenderer.invoke('license:get-state'),
  submitKey: (key) => ipcRenderer.invoke('license:submit-key', key),
  signInGoogle: () => ipcRenderer.invoke('license:sign-in-google'),
  buy: () => ipcRenderer.send('license:buy'),
  quit: () => ipcRenderer.send('license:quit'),
  minimize: () => ipcRenderer.send('license:minimize'),
});
