const { contextBridge, ipcRenderer } = require('electron');

// The corner player window's bridge. Deliberately narrow: it can read the
// now-playing state main pushes, drive playback with a fixed set of actions,
// report its size and ask for its menu — nothing else. Main checks every
// message comes from the corner window itself (see main/miniPlayer.js).
contextBridge.exposeInMainWorld('miniPlayer', {
  ready: () => ipcRenderer.invoke('mini-player:ready'),
  action: (action, arg) => ipcRenderer.invoke('mini-player:action', String(action), arg),
  laidOut: (height) => ipcRenderer.send('mini-player:laid-out', Number(height) || 0),
  menu: () => ipcRenderer.send('mini-player:menu'),
  dismiss: () => ipcRenderer.send('mini-player:dismiss'),
  expand: () => ipcRenderer.send('mini-player:expand'),
  onState: (callback) => ipcRenderer.on('mini-player:state', (_event, payload) => callback(payload))
});
