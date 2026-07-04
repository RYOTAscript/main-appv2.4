const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchApp: (path, options) => ipcRenderer.invoke('launch-app', path, options),
  launchFPSOptimizer: () => ipcRenderer.invoke('launch-fps-optimizer'),
  setAutoStart: (enabled) => ipcRenderer.send('set-autostart', enabled),
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  selectIcon: () => ipcRenderer.invoke('select-icon'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  setFocusHotkey: (accelerator) => ipcRenderer.invoke('set-focus-hotkey', accelerator),
  getFocusHotkey: () => ipcRenderer.invoke('get-focus-hotkey'),
  getLogPath: () => ipcRenderer.invoke('get-log-path'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // FPS Optimizer
  fpsOptimizeOnly: () => ipcRenderer.invoke('fps-optimize-only'),
  fpsDiscordOnly: () => ipcRenderer.invoke('fps-discord-only'),
  fpsNuke: () => ipcRenderer.invoke('fps-nuke'),
  fpsBatterySaver: () => ipcRenderer.invoke('fps-battery'),
  onFpsProgress: (cb) => ipcRenderer.on('fps-progress', (e, data) => cb(data)),
  removeFpsProgressListener: () => ipcRenderer.removeAllListeners('fps-progress'),

  // Spotify
  spotifyGetConfig: () => ipcRenderer.invoke('spotify-get-config'),
  spotifySaveConfig: (config) => ipcRenderer.invoke('spotify-save-config', config),
  spotifyAuthStart: () => ipcRenderer.invoke('spotify-auth-start'),
  spotifyAuthStatus: () => ipcRenderer.invoke('spotify-auth-status'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify-disconnect'),
  spotifyGetCurrentTrack: () => ipcRenderer.invoke('spotify-get-current-track'),
  spotifyControl: (action) => ipcRenderer.invoke('spotify-control', action),
  spotifySetVolume: (volume) => ipcRenderer.invoke('spotify-set-volume', volume),
  spotifySeek: (positionMs) => ipcRenderer.invoke('spotify-seek', positionMs),
  registerSpotifyShortcuts: (hotkeys) => ipcRenderer.invoke('register-spotify-shortcuts', hotkeys),
  disableAllHotkeys: () => ipcRenderer.invoke('disable-all-hotkeys'),
  enableAllHotkeys: () => ipcRenderer.invoke('enable-all-hotkeys'),
  onSpotifyVolumeAdjust: (callback) => ipcRenderer.on('spotify-volume-adjust', (_event, delta) => callback(delta)),
  getWeather: () => ipcRenderer.invoke('get-weather'),
  spotifyGetAudioAnalysis: (trackId) => ipcRenderer.invoke('spotify-get-audio-analysis', trackId),
  spotifyGetAudioFeatures: (trackId) => ipcRenderer.invoke('spotify-get-audio-features', trackId),
  getCloseWindowsStartup: () => ipcRenderer.invoke('get-close-windows-startup'),
  setCloseWindowsStartup: (enabled) => ipcRenderer.invoke('set-close-windows-startup', enabled),
  getLyrics: (trackName, artistName, albumName, durationMs) => ipcRenderer.invoke('get-lyrics', trackName, artistName, albumName, durationMs),



});