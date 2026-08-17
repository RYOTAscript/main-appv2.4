const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Read once at preload time (before any renderer script runs) so getIconPath
// in renderer/ui-utils.js can build file:// URLs synchronously for custom
// launcher icons stored under userData.
const iconsBasePath = ipcRenderer.sendSync('get-icons-base-path-sync');

// Same synchronous read for custom backgrounds (renderer/background.js) — the
// saved background must apply at script load, before first paint settles, so
// there's no flash of the default scene under a custom image/video.
const backgroundsBasePath = ipcRenderer.sendSync('get-backgrounds-base-path-sync');

contextBridge.exposeInMainWorld('electronAPI', {
  iconsBasePath,
  backgroundsBasePath,

  // Background Studio (custom background library)
  backgroundSelect: () => ipcRenderer.invoke('background-select'),
  backgroundList: () => ipcRenderer.invoke('background-list'),
  backgroundDelete: (fileName) => ipcRenderer.invoke('background-delete', fileName),
  backgroundDesktopInfo: () => ipcRenderer.invoke('background-desktop-info'),
  backgroundLiveCapture: (enabled) => ipcRenderer.invoke('background-live-capture', enabled),
  backgroundSampleBehind: () => ipcRenderer.invoke('background-sample-behind'),
  onWindowMoved: (callback) => ipcRenderer.on('window-moved', (_event, pos) => callback(pos)),
  onDisplayChanged: (callback) => ipcRenderer.on('display-changed', () => callback()),

  launchApp: (path, options) => ipcRenderer.invoke('launch-app', path, options),
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

  // Account / License
  licenseGetAccount: () => ipcRenderer.invoke('license:account'),
  licenseRecheck: () => ipcRenderer.invoke('license:recheck'),
  licenseOpenAccount: () => ipcRenderer.invoke('license:open-account'),
  licenseLogout: () => ipcRenderer.invoke('license:logout'),

  // Updates (auto-updater)
  updatesGetState: () => ipcRenderer.invoke('updates:get-state'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  onUpdatesState: (cb) => {
    const listener = (_e, s) => { try { cb(s); } catch (err) { /* ignore */ } };
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },

  // FPS Optimizer
  fpsOptimizeOnly: () => ipcRenderer.invoke('fps-optimize-only'),
  fpsDiscordOnly: () => ipcRenderer.invoke('fps-discord-only'),
  fpsNuke: () => ipcRenderer.invoke('fps-nuke'),
  fpsBatterySaver: () => ipcRenderer.invoke('fps-battery'),
  fpsRevertOptimizations: () => ipcRenderer.invoke('fps-revert-optimizations'),
  fpsAction: (key) => ipcRenderer.invoke('fps-action', key),
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
  getWeather: (opts) => ipcRenderer.invoke('get-weather', opts),
  getCloseWindowsStartup: () => ipcRenderer.invoke('get-close-windows-startup'),
  setCloseWindowsStartup: (enabled) => ipcRenderer.invoke('set-close-windows-startup', enabled),
  getLyrics: (trackName, artistName, albumName, durationMs) => ipcRenderer.invoke('get-lyrics', trackName, artistName, albumName, durationMs),

  // Mini Widgets: Mic Mute
  micMuteToggle: () => ipcRenderer.invoke('mic-mute-toggle'),
  getMicMuteStatus: () => ipcRenderer.invoke('mic-mute-status'),
  registerMicMuteHotkey: (accelerator) => ipcRenderer.invoke('register-mic-mute-hotkey', accelerator),
  setMicMuteOverlayEnabled: (enabled) => ipcRenderer.invoke('set-mic-mute-overlay-enabled', enabled),

  // Mini Widgets: Crosshair
  crosshairApply: (state) => ipcRenderer.invoke('crosshair-apply', state),
  registerCrosshairHotkey: (accelerator) => ipcRenderer.invoke('register-crosshair-hotkey', accelerator),
  onCrosshairVisibilityChanged: (callback) => ipcRenderer.on('crosshair-visibility-changed', (_event, visible) => callback(visible)),

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

  // Mini Widgets: Controller Macros
  controllerMacrosGet: () => ipcRenderer.invoke('controller-macros-get'),
  controllerMacrosSetEnabled: (enabled) => ipcRenderer.invoke('controller-macros-set-enabled', enabled),
  controllerMacrosSave: (macro) => ipcRenderer.invoke('controller-macros-save', macro),
  controllerMacrosDelete: (id) => ipcRenderer.invoke('controller-macros-delete', id),
  controllerMacrosPlay: (id) => ipcRenderer.invoke('controller-macros-play', id),
  controllerMacrosPlaySteps: (steps, speed) => ipcRenderer.invoke('controller-macros-play-steps', steps, speed),
  controllerMacrosStop: () => ipcRenderer.invoke('controller-macros-stop'),
  controllerMacrosSetArmed: (armed) => ipcRenderer.invoke('controller-macros-set-armed', armed),
  controllerMacrosSetToggleHotkey: (accelerator) => ipcRenderer.invoke('controller-macros-set-toggle-hotkey', accelerator),
  controllerMacrosSetPadType: (type) => ipcRenderer.invoke('controller-macros-set-pad-type', type),
  controllerMacrosDriverStatus: () => ipcRenderer.invoke('controller-macros-driver-status'),
  controllerMacrosOpenDriverPage: () => ipcRenderer.invoke('controller-macros-open-driver-page'),
  onControllerMacrosStatus: (callback) => ipcRenderer.on('controller-macros-status', (_event, data) => callback(data)),

  // Mini Widgets: Spotify Enhanced
  spotifyGetQueue: () => ipcRenderer.invoke('spotify-get-queue'),
  spotifyRecentlyPlayed: () => ipcRenderer.invoke('spotify-recently-played'),
  spotifyGetPlaylists: () => ipcRenderer.invoke('spotify-get-playlists'),
  spotifyPlayContext: (contextUri) => ipcRenderer.invoke('spotify-play-context', contextUri),
  spotifyIsSaved: (trackId) => ipcRenderer.invoke('spotify-is-saved', trackId),
  spotifySetSaved: (trackId, saved) => ipcRenderer.invoke('spotify-set-saved', trackId, saved),

  // Mini Widgets: Screen Resolution Manager
  screenResolutionList: () => ipcRenderer.invoke('screen-resolution-list'),
  screenResolutionSet: (device, width, height, refresh) => ipcRenderer.invoke('screen-resolution-set', device, width, height, refresh),

  // Mini Widgets: Video Editor
  videoCheck: () => ipcRenderer.invoke('video-check'),
  videoPickInput: () => ipcRenderer.invoke('video-pick-input'),
  videoPickOutput: (defaultPath) => ipcRenderer.invoke('video-pick-output', defaultPath),
  videoExport: (opts) => ipcRenderer.invoke('video-export', opts),
  videoCancel: () => ipcRenderer.invoke('video-cancel'),
  videoReveal: (filePath) => ipcRenderer.invoke('video-reveal', filePath),
  videoMakeProxy: (opts) => ipcRenderer.invoke('video-make-proxy', opts),
  videoCancelProxy: () => ipcRenderer.invoke('video-cancel-proxy'),
  videoTimelineAssets: (opts) => ipcRenderer.invoke('video-timeline-assets', opts),
  videoAudioStems: (opts) => ipcRenderer.invoke('video-audio-stems', opts),
  onVideoExportProgress: (callback) => ipcRenderer.on('video-export-progress', (_event, data) => callback(data)),
  onVideoProxyProgress: (callback) => ipcRenderer.on('video-proxy-progress', (_event, data) => callback(data)),

  // Mini Widgets: Bluetooth Manager
  bluetoothList: () => ipcRenderer.invoke('bluetooth-list'),
  bluetoothStatus: () => ipcRenderer.invoke('bluetooth-status'),
  bluetoothScan: () => ipcRenderer.invoke('bluetooth-scan'),
  bluetoothRadioGet: () => ipcRenderer.invoke('bluetooth-radio-get'),
  bluetoothRadioSet: (state) => ipcRenderer.invoke('bluetooth-radio-set', state),
  bluetoothConnect: (address) => ipcRenderer.invoke('bluetooth-connect', address),
  bluetoothDisconnect: (address) => ipcRenderer.invoke('bluetooth-disconnect', address),
  bluetoothRemove: (address) => ipcRenderer.invoke('bluetooth-remove', address),
  bluetoothPair: (address) => ipcRenderer.invoke('bluetooth-pair', address),

  // Mini Widgets: Translucent Taskbar
  taskbarApply: (mode, color) => ipcRenderer.invoke('taskbar-apply', mode, color),
  taskbarClear: () => ipcRenderer.invoke('taskbar-clear'),
  taskbarStatus: () => ipcRenderer.invoke('taskbar-status'),
  taskbarInstallTtb: () => ipcRenderer.invoke('taskbar-install-ttb'),

  // Mini Widgets: File Search (Everything-style)
  fileSearchGetConfig: () => ipcRenderer.invoke('file-search:get-config'),
  fileSearchSetConfig: (patch) => ipcRenderer.invoke('file-search:set-config', patch),
  fileSearchListDrives: () => ipcRenderer.invoke('file-search:list-drives'),
  fileSearchAddRoot: (p) => ipcRenderer.invoke('file-search:add-root', p),
  fileSearchRemoveRoot: (p) => ipcRenderer.invoke('file-search:remove-root', p),
  fileSearchPickFolder: () => ipcRenderer.invoke('file-search:pick-folder'),
  fileSearchIndexStatus: () => ipcRenderer.invoke('file-search:index-status'),
  fileSearchBuildIndex: () => ipcRenderer.invoke('file-search:build-index'),
  fileSearchCancelIndex: () => ipcRenderer.invoke('file-search:cancel-index'),
  fileSearchQuery: (q, opts) => ipcRenderer.invoke('file-search:query', q, opts),
  fileSearchOpen: (p) => ipcRenderer.invoke('file-search:open', p),
  fileSearchReveal: (p) => ipcRenderer.invoke('file-search:reveal', p),
  onFileSearchIndexProgress: (callback) => ipcRenderer.on('file-search:index-progress', (_event, data) => callback(data)),
  removeFileSearchIndexProgressListener: () => ipcRenderer.removeAllListeners('file-search:index-progress'),

  // Mini Widgets: Claude Limit Auto-Continue
  claudeLimitListWindows: () => ipcRenderer.invoke('claude-limit:list-windows'),
  claudeLimitSend: (hwnd, prompt, pressEnter) => ipcRenderer.invoke('claude-limit:send', hwnd, prompt, pressEnter),
  claudeLimitReadClipboard: () => ipcRenderer.invoke('claude-limit:read-clipboard'),
  claudeLimitSetWatch: (enabled) => ipcRenderer.invoke('claude-limit:set-watch', enabled),
  claudeLimitSetKeepAwake: (enabled) => ipcRenderer.invoke('claude-limit:set-keep-awake', enabled),
  claudeLimitNotify: (title, body) => ipcRenderer.invoke('claude-limit:notify', title, body),
  claudeLimitReadWindowText: (process, title) => ipcRenderer.invoke('claude-limit:read-window-text', process, title),
  claudeLimitSetWindowWatch: (enabled, process, title) => ipcRenderer.invoke('claude-limit:set-window-watch', enabled, process, title),
  claudeLimitReadCcLimit: () => ipcRenderer.invoke('claude-limit:read-cc-limit'),
  claudeLimitSetCcWatch: (enabled) => ipcRenderer.invoke('claude-limit:set-cc-watch', enabled),
  onClaudeLimitClipboardHit: (callback) => ipcRenderer.on('claude-limit:clipboard-hit', (_event, data) => callback(data)),
  removeClaudeLimitClipboardHitListener: () => ipcRenderer.removeAllListeners('claude-limit:clipboard-hit'),
  onClaudeLimitWindowHit: (callback) => ipcRenderer.on('claude-limit:window-hit', (_event, data) => callback(data)),
  removeClaudeLimitWindowHitListener: () => ipcRenderer.removeAllListeners('claude-limit:window-hit'),
  onClaudeLimitCcHit: (callback) => ipcRenderer.on('claude-limit:cc-hit', (_event, data) => callback(data)),
  removeClaudeLimitCcHitListener: () => ipcRenderer.removeAllListeners('claude-limit:cc-hit'),

  // Mini Widgets: Clipboard
  clipboardGet: () => ipcRenderer.invoke('clipboard-get'),
  clipboardSetEnabled: (enabled) => ipcRenderer.invoke('clipboard-set-enabled', enabled),
  clipboardCopy: (id) => ipcRenderer.invoke('clipboard-copy', id),
  clipboardTogglePin: (id) => ipcRenderer.invoke('clipboard-toggle-pin', id),
  clipboardDelete: (id) => ipcRenderer.invoke('clipboard-delete', id),
  clipboardClear: () => ipcRenderer.invoke('clipboard-clear'),
  onClipboardChanged: (callback) => ipcRenderer.on('clipboard-changed', (_event, data) => callback(data)),

  // Mini Widgets: Quick Launch Enhanced
  quickLaunchDetectGames: () => ipcRenderer.invoke('quicklaunch-detect-games'),
  quickLaunchRunning: (names) => ipcRenderer.invoke('quicklaunch-running', names),
  quickLaunchLaunchUri: (uri) => ipcRenderer.invoke('quicklaunch-launch-uri', uri),
  quickLaunchLaunchMany: (paths) => ipcRenderer.invoke('quicklaunch-launch-many', paths),

  // Mini Widgets: Volume Mixer
  volumeMixerSetEnabled: (enabled) => ipcRenderer.invoke('volume-mixer-set-enabled', enabled),
  volumeMixerList: () => ipcRenderer.invoke('volume-mixer-list'),
  volumeMixerSetApp: (pid, volume) => ipcRenderer.invoke('volume-mixer-set-app', pid, volume),
  volumeMixerMuteApp: (pid, muted) => ipcRenderer.invoke('volume-mixer-mute-app', pid, muted),
  volumeMixerSetMaster: (volume) => ipcRenderer.invoke('volume-mixer-set-master', volume),
  volumeMixerMuteMaster: (muted) => ipcRenderer.invoke('volume-mixer-mute-master', muted),
  volumeMixerGetHotkeys: () => ipcRenderer.invoke('volume-mixer-get-hotkeys'),
  volumeMixerSetHotkey: (which, accelerator) => ipcRenderer.invoke('volume-mixer-set-hotkey', which, accelerator),
  onVolumeMixerChanged: (callback) => ipcRenderer.on('volume-mixer-changed', () => callback()),

  // Mini Widgets: Discord Rich Presence
  discordRpcGet: () => ipcRenderer.invoke('discord-rpc-get'),
  discordRpcSetEnabled: (enabled) => ipcRenderer.invoke('discord-rpc-set-enabled', enabled),
  discordRpcSetConfig: (config) => ipcRenderer.invoke('discord-rpc-set-config', config),
  discordRpcReconnect: () => ipcRenderer.invoke('discord-rpc-reconnect'),
  onDiscordRpcStatus: (callback) => ipcRenderer.on('discord-rpc-status', (_event, data) => callback(data)),

  // Game Mode
  gameModeGet: () => ipcRenderer.invoke('game-mode-get'),
  gameModeSetEnabled: (enabled) => ipcRenderer.invoke('game-mode-set-enabled', enabled),
  gameModeSaveRule: (rule) => ipcRenderer.invoke('game-mode-save-rule', rule),
  gameModeDeleteRule: (id) => ipcRenderer.invoke('game-mode-delete-rule', id),
  gameModeListProcesses: () => ipcRenderer.invoke('game-mode-list-processes'),
  onGameModeEvent: (callback) => ipcRenderer.on('game-mode-event', (_event, data) => callback(data)),
  onGameModeDetect: (callback) => ipcRenderer.on('game-mode-detect', (_event, data) => callback(data)),

  // Mini Widgets: ValClips Quality (TikTok clip optimiser)
  // Drag-and-drop File objects can only be resolved to disk paths in the preload
  // context (webUtils) — the renderer hands over the File and gets the path back.
  valclipsPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  valclipsFfmpegState: () => ipcRenderer.invoke('valclips:ffmpeg-state'),
  valclipsFfmpegSetup: () => ipcRenderer.invoke('valclips:ffmpeg-setup'),
  valclipsFfmpegRecheck: () => ipcRenderer.invoke('valclips:ffmpeg-recheck'),
  valclipsFilesAdd: (paths, overwriteConfirmed = false) => ipcRenderer.invoke('valclips:files-add', paths, overwriteConfirmed),
  valclipsFilesOpenDialog: () => ipcRenderer.invoke('valclips:files-open-dialog'),
  valclipsJobsList: () => ipcRenderer.invoke('valclips:jobs-list'),
  valclipsJobsRemove: (id) => ipcRenderer.invoke('valclips:jobs-remove', id),
  valclipsJobsClearFinished: () => ipcRenderer.invoke('valclips:jobs-clear-finished'),
  valclipsJobsSetOverrides: (id, overrides) => ipcRenderer.invoke('valclips:jobs-set-overrides', id, overrides),
  valclipsJobsCancel: (id) => ipcRenderer.invoke('valclips:jobs-cancel', id),
  valclipsJobsRequeue: (id) => ipcRenderer.invoke('valclips:jobs-requeue', id),
  valclipsPreviewGenerate: (id, overrides) => ipcRenderer.invoke('valclips:preview-generate', id, overrides),
  valclipsCompareGenerate: (id, timeSec) => ipcRenderer.invoke('valclips:compare-generate', id, timeSec),
  valclipsSettingsGet: () => ipcRenderer.invoke('valclips:settings-get'),
  valclipsSettingsSet: (patch) => ipcRenderer.invoke('valclips:settings-set', patch),
  valclipsSettingsPickOutputFolder: () => ipcRenderer.invoke('valclips:settings-pick-output-folder'),
  valclipsShowInFolder: (p) => ipcRenderer.invoke('valclips:show-in-folder', p),
  valclipsOpenSettingsFile: () => ipcRenderer.invoke('valclips:open-settings-file'),
  onValclipsJobs: (callback) => ipcRenderer.on('valclips:jobs', (_event, data) => callback(data)),
  onValclipsFfmpegState: (callback) => ipcRenderer.on('valclips:ffmpeg-state', (_event, data) => callback(data)),

  // Mini Widgets: App Installer (Ninite-style bulk installer, winget-backed)
  appInstallerCatalog: () => ipcRenderer.invoke('app-installer:catalog'),
  appInstallerStatus: () => ipcRenderer.invoke('app-installer:status'),
  appInstallerInstall: (ids) => ipcRenderer.invoke('app-installer:install', ids),
  appInstallerCancel: () => ipcRenderer.invoke('app-installer:cancel'),
  appInstallerInstalled: () => ipcRenderer.invoke('app-installer:installed'),
  appInstallerExportPresets: (json) => ipcRenderer.invoke('app-installer:export-presets', json),
  appInstallerImportPresets: () => ipcRenderer.invoke('app-installer:import-presets'),
  appInstallerOpenWingetStore: () => ipcRenderer.invoke('app-installer:open-winget-store'),
  onAppInstallerProgress: (callback) => ipcRenderer.on('app-installer:progress', (_event, data) => callback(data)),

  // Mini Widgets: Windows Debloat (per-user AppX removal + reversible HKCU tweaks)
  debloatCatalog: () => ipcRenderer.invoke('debloat:catalog'),
  debloatStatus: () => ipcRenderer.invoke('debloat:status'),
  debloatScanInstalled: () => ipcRenderer.invoke('debloat:scan-installed'),
  debloatRemove: (names) => ipcRenderer.invoke('debloat:remove', names),
  debloatCancel: () => ipcRenderer.invoke('debloat:cancel'),
  debloatReadTweaks: () => ipcRenderer.invoke('debloat:read-tweaks'),
  debloatSetTweak: (id, on) => ipcRenderer.invoke('debloat:set-tweak', { id, on }),
  debloatRestartExplorer: () => ipcRenderer.invoke('debloat:restart-explorer'),
  debloatRestorePoint: () => ipcRenderer.invoke('debloat:restore-point'),
  onDebloatProgress: (callback) => ipcRenderer.on('debloat:progress', (_event, data) => callback(data)),

});