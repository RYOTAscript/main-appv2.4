const { contextBridge, ipcRenderer } = require('electron');

// The floating timer window's bridge. Deliberately narrow: a floating window
// can read and drive ITS OWN timer and nothing else. It never names a timer id —
// main works out which timer from the sending window (see main/timers.js).
contextBridge.exposeInMainWorld('timerFloat', {
  ready: () => ipcRenderer.invoke('timer-float:ready'),
  action: (action, arg) => ipcRenderer.invoke('timer-float:action', String(action), arg),
  menu: () => ipcRenderer.send('timer-float:menu'),
  hoverHandle: (over) => ipcRenderer.send('timer-float:hover-handle', !!over),
  laidOut: () => ipcRenderer.send('timer-float:laid-out'),
  exitGhost: () => ipcRenderer.send('timer-float:exit-ghost'),
  close: () => ipcRenderer.send('timer-float:close'),
  openApp: () => ipcRenderer.send('timer-float:open-app'),
  onState: (callback) => ipcRenderer.on('timer-float:state', (_event, payload) => callback(payload)),
  onAlert: (callback) => ipcRenderer.on('timer-float:alert', (_event, payload) => callback(payload))
});
