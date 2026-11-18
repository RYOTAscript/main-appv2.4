const { contextBridge, ipcRenderer } = require('electron');

// The floating formula sheet's bridge. Deliberately narrow: an overlay can read
// ITS OWN sheet and change its own look (size, text size, click-through) and
// nothing else — it can't edit, rename or delete a sheet. It never names a
// sheet id; main works out which sheet from the sending window (see
// main/study.js).
contextBridge.exposeInMainWorld('studyFloat', {
  ready: () => ipcRenderer.invoke('study-float:ready'),
  menu: () => ipcRenderer.send('study-float:menu'),
  hoverHandle: (over) => ipcRenderer.send('study-float:hover-handle', !!over),
  exitGhost: () => ipcRenderer.send('study-float:exit-ghost'),
  ghost: () => ipcRenderer.send('study-float:ghost'),
  zoom: (dir) => ipcRenderer.send('study-float:zoom', Math.sign(Number(dir) || 0)),
  resizeTo: (width, height) => ipcRenderer.send('study-float:resize-to', Math.round(Number(width) || 0), Math.round(Number(height) || 0)),
  resizeEnd: () => ipcRenderer.send('study-float:resize-end'),
  close: () => ipcRenderer.send('study-float:close'),
  openApp: () => ipcRenderer.send('study-float:open-app'),
  onState: (callback) => ipcRenderer.on('study-float:state', (_event, payload) => callback(payload))
});
