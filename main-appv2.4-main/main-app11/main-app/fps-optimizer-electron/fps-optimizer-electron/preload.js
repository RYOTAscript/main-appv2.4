const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Metrics
  getMetrics: () => ipcRenderer.invoke('get-metrics'),
  onMetrics: (cb) => ipcRenderer.on('metrics', (e, data) => cb(data)),

  // Boosts
  runBoost: (type) => ipcRenderer.invoke('run-boost', type),
  killStandard: () => ipcRenderer.invoke('kill-standard'),
  killDiscord: () => ipcRenderer.invoke('kill-discord'),
  killNuke: () => ipcRenderer.invoke('kill-nuke'),

  // Game Mode
  toggleGameMode: () => ipcRenderer.invoke('toggle-gamemode'),

  // Single actions
  runAction: (action) => ipcRenderer.invoke('run-action', action),

  // Battery
  batterySave: () => ipcRenderer.invoke('battery-save'),
  batteryRevert: () => ipcRenderer.invoke('battery-revert'),

  // Overlay
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  onOverlayData: (cb) => ipcRenderer.on('overlay-data', (e, data) => cb(data)),

  // Progress & Logs
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (e, data) => cb(data)),

  // Startup check
  startupCheck: () => ipcRenderer.invoke('startup-check'),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
