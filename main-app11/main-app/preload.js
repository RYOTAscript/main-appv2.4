const { contextBridge, ipcRenderer } = require('electron');

// Read once at preload time (before any renderer script runs) so getIconPath
// in renderer/ui-utils.js can build file:// URLs synchronously for custom
// launcher icons stored under userData.
const iconsBasePath = ipcRenderer.sendSync('get-icons-base-path-sync');

contextBridge.exposeInMainWorld('electronAPI', {
  iconsBasePath,
  launchApp: (path, options) => ipcRenderer.invoke('launch-app', path, options),
  launchFPSOptimizer: () => ipcRenderer.invoke('launch-fps-optimizer'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  selectIcon: () => ipcRenderer.invoke('select-icon'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  setFocusHotkey: (accelerator) => ipcRenderer.invoke('set-focus-hotkey', accelerator),
  getFocusHotkey: () => ipcRenderer.invoke('get-focus-hotkey'),
  unregisterFocusHotkey: () => ipcRenderer.invoke('unregister-focus-hotkey'),
  getLogPath: () => ipcRenderer.invoke('get-log-path'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // FPS Optimizer
  fpsOptimizeOnly: () => ipcRenderer.invoke('fps-optimize-only'),
  fpsDiscordOnly: () => ipcRenderer.invoke('fps-discord-only'),
  fpsNuke: () => ipcRenderer.invoke('fps-nuke'),
  fpsBatterySaver: () => ipcRenderer.invoke('fps-battery'),
  fpsRevertOptimizations: () => ipcRenderer.invoke('fps-revert-optimizations'),
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
  startSpotifySleepTimer: (minutes) => ipcRenderer.invoke('spotify-sleep-timer-start', minutes),
  cancelSpotifySleepTimer: () => ipcRenderer.invoke('spotify-sleep-timer-cancel'),
  getSpotifySleepTimerStatus: () => ipcRenderer.invoke('spotify-sleep-timer-status'),
  onSpotifySleepTimerEnded: (callback) => ipcRenderer.on('spotify-sleep-timer-ended', () => callback()),
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

  // Mini Widgets: Mic Mute
  micMuteToggle: () => ipcRenderer.invoke('mic-mute-toggle'),
  getMicMuteStatus: () => ipcRenderer.invoke('mic-mute-status'),
  registerMicMuteHotkey: (accelerator) => ipcRenderer.invoke('register-mic-mute-hotkey', accelerator),
  setMicMuteOverlayEnabled: (enabled) => ipcRenderer.invoke('set-mic-mute-overlay-enabled', enabled),

  // Display monitor selection
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getSelectedDisplay: () => ipcRenderer.invoke('get-selected-display'),
  setSelectedDisplay: (displayId) => ipcRenderer.invoke('set-selected-display', displayId),

  // Mini Widgets: Macros
  macrosGet: () => ipcRenderer.invoke('macros-get'),
  macrosSetEnabled: (enabled) => ipcRenderer.invoke('macros-set-enabled', enabled),
  macrosSave: (macro) => ipcRenderer.invoke('macros-save', macro),
  macrosDelete: (id) => ipcRenderer.invoke('macros-delete', id),
  macrosRecordStart: (targetId, filters) => ipcRenderer.invoke('macros-record-start', targetId, filters),
  macrosPlay: (id) => ipcRenderer.invoke('macros-play', id),
  macrosStop: () => ipcRenderer.invoke('macros-stop'),
  macrosSetToggleHotkey: (accelerator) => ipcRenderer.invoke('macros-set-toggle-hotkey', accelerator),
  macrosSetArmed: (armed) => ipcRenderer.invoke('macros-set-armed', armed),
  macrosCaptureArm: () => ipcRenderer.invoke('macros-capture-arm'),
  macrosCaptureCancel: () => ipcRenderer.invoke('macros-capture-cancel'),
  macrosExport: () => ipcRenderer.invoke('macros-export'),
  macrosImport: () => ipcRenderer.invoke('macros-import'),
  onMacrosStatus: (callback) => ipcRenderer.on('macros-status', (_event, data) => callback(data)),

  // Mini Widgets: Clipboard
  clipboardGet: () => ipcRenderer.invoke('clipboard-get'),
  clipboardSetEnabled: (enabled) => ipcRenderer.invoke('clipboard-set-enabled', enabled),
  clipboardCopy: (id) => ipcRenderer.invoke('clipboard-copy', id),
  clipboardTogglePin: (id) => ipcRenderer.invoke('clipboard-toggle-pin', id),
  clipboardDelete: (id) => ipcRenderer.invoke('clipboard-delete', id),
  clipboardClear: () => ipcRenderer.invoke('clipboard-clear'),
  onClipboardChanged: (callback) => ipcRenderer.on('clipboard-changed', (_event, data) => callback(data)),

});