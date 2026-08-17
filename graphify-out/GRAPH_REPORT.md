# Graph Report - .  (2026-08-12)

## Corpus Check
- Large corpus: 246 files · ~543,254 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 2119 nodes · 4151 edges · 102 communities (91 shown, 11 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.52)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Controller Macros (UI)
- ValClips Quality UI
- ValClips Panel
- Background & Themes
- Video Editor
- Electron Main Process
- Beat Glow Visualizer
- Keyboard/Mouse Macros
- Website Auth Deps
- ValClips Analysis Engine
- Settings Panel
- Controller Macros (Main)
- Claude Limit Widget
- Spotify Enhanced Widget
- ValClips Build Config
- File Search Widget
- ValClips Encoder
- Cache & PKCE Auth
- Widget Settings
- Website Sign-in
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95

## God Nodes (most connected - your core abstractions)
1. `cn()` - 34 edges
2. `ensureVersionedScript()` - 23 edges
3. `runCmd()` - 21 edges
4. `renderControllerMacrosPanel()` - 21 edges
5. `applyBackground()` - 20 edges
6. `saveCmMacro()` - 20 edges
7. `saveMacro()` - 20 edges
8. `bluetoothPaint()` - 19 edges
9. `getCmMacro()` - 19 edges
10. `runOrThrow()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `SignInPage()` --calls--> `auth()`  [EXTRACTED]
  website/src/app/signin/page.tsx → website/src/lib/auth.ts
- `FeatureCard()` --calls--> `cn()`  [EXTRACTED]
  website/src/components/sections/Features.tsx → website/src/lib/cn.ts
- `init()` --calls--> `runCmd()`  [EXTRACTED]
  main-appv2.4-main/main-app11/main-app/main/appInstaller.js → main-appv2.4-main/main-app11/main-app/main/shellUtils.js
- `init()` --calls--> `runCmd()`  [EXTRACTED]
  main-appv2.4-main/main-app11/main-app/main/appLauncher.js → main-appv2.4-main/main-app11/main-app/main/shellUtils.js
- `init()` --calls--> `ensureVersionedScript()`  [EXTRACTED]
  main-appv2.4-main/main-app11/main-app/main/autostart.js → main-appv2.4-main/main-app11/main-app/main/scriptCache.js

## Import Cycles
- None detected.

## Communities (102 total, 11 thin omitted)

### Community 0 - "Controller Macros (UI)"
Cohesion: 0.06
Nodes (64): addCmStep(), addCmTemplate(), addEmptyCmMacro(), cancelCmPicker(), clearCmSteps(), cm2kFlick(), cm2kHold(), cm2kTurbo() (+56 more)

### Community 1 - "ValClips Quality UI"
Cohesion: 0.07
Nodes (50): VqApi, App(), AnalysisBadges(), AnalysisDetail(), CompareViewer(), QualityReport(), verdictFor(), DropZone() (+42 more)

### Community 2 - "ValClips Panel"
Cohesion: 0.06
Nodes (60): isValclipsEnabled(), renderValclipsPanel(), VC_CHECKLIST, VC_STATUS_META, vcAdd(), vcAnalysisDetail(), vcBadges(), vcBindDropzone() (+52 more)

### Community 3 - "Background & Themes"
Cohesion: 0.09
Nodes (57): applyBackground(), BG_BOKEH_TINTS, BG_DEFAULTS, BG_PRESETS, BG_TEXT_THEMES, BG_THEMES, bgAccentify(), bgAddCustom() (+49 more)

### Community 4 - "Video Editor"
Cohesion: 0.09
Nodes (50): bindProxyProgress(), bindVideoEditor(), initVeKeys(), isVideoEditorEnabled(), renderVeAudioTracks(), renderVideoEditorPanel(), ve, veApplyPreviewAudio() (+42 more)

### Community 5 - "Electron Main Process"
Cohesion: 0.04
Nodes (47): { app, BrowserWindow, shell, ipcMain, globalShortcut, Menu, Tray, session, desktopCapturer, crashReporter }, buildTrayMenu(), cachePath, clipboardHistory, createTray(), createWindow(), focusMainWindow(), fs (+39 more)

### Community 6 - "Beat Glow Visualizer"
Cohesion: 0.07
Nodes (47): animateSpotifyDisk(), applyBeatGlowVisual(), beatEngineState, checkBeatEvents(), checkBpmBeat(), checkLiveAudioBeat(), ensureLiveAudioAnalyser(), liveAudio (+39 more)

### Community 7 - "Keyboard/Mouse Macros"
Cohesion: 0.08
Nodes (41): addEmptyMacro(), addMacroStep(), armMacroPointCapture(), clearMacroClickPos(), clearMacroSteps(), deleteMacro(), duplicateMacro(), duplicateMacroStep() (+33 more)

### Community 8 - "Website Auth Deps"
Cohesion: 0.04
Nodes (46): google-auth-library, next-auth, @next-auth/prisma-adapter, prisma, @prisma/client, @types/node, @types/react, @types/react-dom (+38 more)

### Community 9 - "ValClips Analysis Engine"
Cohesion: 0.08
Nodes (36): analyzeContent(), extractMetadata(), mean(), round4(), api, classifyMotion(), classifyNoise(), decide() (+28 more)

### Community 10 - "Settings Panel"
Cohesion: 0.07
Nodes (27): cancelSpotifySleepTimer(), closeSettingsDone(), formatSleepTimerRemaining(), loadSpotifyExtrasCollapsed(), markSettingsSaved(), markSettingsSaving(), persistSettings(), refreshSleepTimerUI() (+19 more)

### Community 11 - "Controller Macros (Main)"
Cohesion: 0.08
Nodes (41): { app, ipcMain, globalShortcut, shell }, clampInt(), compileStepsToEvents(), { ensureVersionedScript }, fs, init(), newMacroId(), PAD_BUTTONS (+33 more)

### Community 12 - "Claude Limit Widget"
Cohesion: 0.15
Nodes (39): applyClaudeLimitEnabled(), clArmAt(), clArmNow(), clContinueNow(), clDefaults(), clDetectFromClipboard(), clDisarm(), clDurationToMs() (+31 more)

### Community 13 - "Spotify Enhanced Widget"
Cohesion: 0.13
Nodes (38): applyEwPosition(), applySpotifyEnhancedEnabled(), applySpotifyEwDraggable(), enhancedHandleFetchState(), ewRenderPlaylists(), ewRenderQueue(), ewRenderRecent(), ewStateHtml() (+30 more)

### Community 14 - "ValClips Build Config"
Cohesion: 0.05
Nodes (37): electron-vite, author, dependencies, react, react-dom, description, devDependencies, autoprefixer (+29 more)

### Community 15 - "File Search Widget"
Cohesion: 0.11
Nodes (34): fsAddDrives(), fsBuildIndex(), fsClearQuery(), fsCopyPath(), fsFileIcon(), fsFmtBuiltAt(), fsFmtDate(), fsFmtSize() (+26 more)

### Community 16 - "ValClips Encoder"
Cohesion: 0.12
Nodes (31): commitTemp(), discardTemp(), tempPathFor(), activeHandles, AttemptResult, cancelled, CancelledError, describePlan() (+23 more)

### Community 17 - "Cache & PKCE Auth"
Cohesion: 0.08
Nodes (25): RFC-7636, BoundedCache, https, safeFetch(), { BoundedCache }, init(), { ipcMain }, parsePlainLyrics() (+17 more)

### Community 18 - "Widget Settings"
Cohesion: 0.10
Nodes (23): addNewApp(), animateWidgetIn(), animateWidgetOut(), applyAppearance(), applyMiniWidgetPrefs(), applyWidgetPrefs(), changeIcon(), cleanAppPath() (+15 more)

### Community 19 - "Website Sign-in"
Cohesion: 0.11
Nodes (22): dynamic, metadata, SignInPage(), GoogleSignInButton(), BackToTop(), AppWindowMock(), NOTE_LINES, NOTE_TEXT (+14 more)

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (28): { app, ipcMain }, { ensureVersionedScript }, fs, init(), os, path, { runCmd }, { ensureVersionedScript } (+20 more)

### Community 21 - "Community 21"
Cohesion: 0.14
Nodes (32): applyBluetoothEnabled(), batteryBadge(), BLUETOOTH_TYPE_META, bluetoothAction(), bluetoothAutoRefresh(), bluetoothBusy, bluetoothData, bluetoothDeviceIcon() (+24 more)

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (27): BUNDLED_ICON_NAMES, { ensureVersionedScript }, fs, init(), { ipcMain, shell, dialog }, isSpotifyPath(), path, { runCmd } (+19 more)

### Community 23 - "Community 23"
Cohesion: 0.17
Nodes (30): closeWidgetDetail(), closeWidgetLibrary(), getMiniWidgetById(), getVisibleWidgets(), getWidgetFavs(), getWidgetRecents(), isMiniWidgetEnabled(), isWidgetFav() (+22 more)

### Community 24 - "Community 24"
Cohesion: 0.10
Nodes (21): inter, jetbrains, jsonLd, metadata, viewport, AccentPicker(), AccentContext, AccentContextValue (+13 more)

### Community 25 - "Community 25"
Cohesion: 0.07
Nodes (27): { execFile }, fs, IMAGE_EXTENSIONS, init(), { ipcMain, dialog, screen, desktopCapturer }, mediaType(), path, VIDEO_EXTENSIONS (+19 more)

### Community 26 - "Community 26"
Cohesion: 0.16
Nodes (25): atomicWriteFile(), cancelJob(), onStateChange(), gotLock, handle(), registerIpc(), logFilePath(), ComparePair (+17 more)

### Community 27 - "Community 27"
Cohesion: 0.09
Nodes (27): { app, BrowserWindow, ipcMain, screen }, BATTERY_REVERT, BATTERY_STEPS, calculateFps(), collectMetrics(), COLORS, createWindow(), { exec, execSync } (+19 more)

### Community 28 - "Community 28"
Cohesion: 0.07
Nodes (28): build, appId, directories, nsis, productName, win, dependencies, systeminformation (+20 more)

### Community 29 - "Community 29"
Cohesion: 0.15
Nodes (26): applyLyricsResult(), cacheLyricsResult(), clearLyricsDisplay(), createLyricsSlotEl(), escapeHtml(), fadeOutLyricsConveyor(), getLyricsWindowEl(), layoutLyricsSlots() (+18 more)

### Community 30 - "Community 30"
Cohesion: 0.13
Nodes (16): FAQ, HELP, metadata, ScaledStage(), ScrollReveal(), FeatureCard(), Features(), WidgetLibrary() (+8 more)

### Community 31 - "Community 31"
Cohesion: 0.16
Nodes (25): applyGameModeEnabled(), applyGameProfile(), gameModeActionSummary(), gameModeActionToggle(), gameModeAddRule(), gameModeApplied, gameModeCancelEdit(), gameModeCaptureEditor() (+17 more)

### Community 32 - "Community 32"
Cohesion: 0.07
Nodes (26): esnext, next-env.d.ts, .next/types/**/*.ts, node_modules, **/*.ts, **/*.tsx, compilerOptions, allowJs (+18 more)

### Community 33 - "Community 33"
Cohesion: 0.22
Nodes (24): applyNotesEnhancedEnabled(), getActiveNote(), getNotesData(), getNotesHistory(), isNotesEnhancedEnabled(), newNoteObject(), noteRelTime(), notesAddChecklistItem() (+16 more)

### Community 34 - "Community 34"
Cohesion: 0.18
Nodes (24): applyVisualizerPrefs(), compileVizShader(), ensureVizAudioAnalyser(), getVizBassEnergy(), getVizCanvas(), getVizMidEnergy(), getVizTrebleEnergy(), initVizAuraProgram() (+16 more)

### Community 35 - "Community 35"
Cohesion: 0.15
Nodes (17): AccountPage(), dynamic, initials(), metadata, handler, DownloadPage(), dynamic, metadata (+9 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (21): aiBodyHtml(), aiClear(), aiDismissProgress(), aiFooterHtml(), aiGridHtml(), aiInstall(), aiInstalled, aiLoadSelection() (+13 more)

### Community 37 - "Community 37"
Cohesion: 0.14
Nodes (20): dynamic, POST(), runtime, dynamic, GET(), runtime, dynamic, POST() (+12 more)

### Community 38 - "Community 38"
Cohesion: 0.19
Nodes (22): b64url(), check(), clearStore(), crypto, fs, getAccount(), getCachedUnlock(), getState() (+14 more)

### Community 39 - "Community 39"
Cohesion: 0.17
Nodes (21): applyFocusHotkey(), camelToKebab(), cancelHotkeyBind(), DEFAULT_APPS, disableAllHotkeys(), enableAllHotkeys(), formatHotkeyDisplay(), formatPairedHotkeyDisplay() (+13 more)

### Community 40 - "Community 40"
Cohesion: 0.27
Nodes (21): ensureTimerTick(), formatTimerClock(), getTimerState(), initTimerWidget(), isTimerEnabled(), renderTimerPanel(), setTimerState(), TIMER_DEFAULT_STATE (+13 more)

### Community 41 - "Community 41"
Cohesion: 0.22
Nodes (21): appIsRunning(), applyQuickLaunchEnhancedEnabled(), appMatchesFolder(), appProcessName(), DEFAULT_QL_FOLDERS, detectAndAddGames(), getLaunchProfiles(), getQuickLaunchFolders() (+13 more)

### Community 42 - "Community 42"
Cohesion: 0.09
Nodes (21): compilerOptions, baseUrl, esModuleInterop, jsx, lib, module, moduleResolution, noEmit (+13 more)

### Community 43 - "Community 43"
Cohesion: 0.11
Nodes (19): ALREADY_CODES, APP_BY_ID, CATALOG, init(), { ipcMain, shell }, { runCmd, runCmdSync }, BATTERY_STEPS, fs (+11 more)

### Community 44 - "Community 44"
Cohesion: 0.17
Nodes (17): getState(), paths(), registerPipeline(), EncodeRunner, initPipeline(), runPipeline(), detectFrameRateMode(), FfprobeStream (+9 more)

### Community 45 - "Community 45"
Cohesion: 0.19
Nodes (5): crypto, fs, Logger, os, path

### Community 46 - "Community 46"
Cohesion: 0.21
Nodes (19): applyVolumeMixerEnabled(), hookVolMixChanged(), isVolMixEnabled(), renderVolumeMixerPanel(), startVolMixPoll(), stopVolMixPoll(), volMixApplyThrottle, volMixApplyVolume() (+11 more)

### Community 47 - "Community 47"
Cohesion: 0.22
Nodes (18): clearScreenResRevert(), doScreenResRevert(), isScreenResEnabled(), modeKey(), modeLabel(), renderScreenResolutionPanel(), screenResApply(), screenResApplyFav() (+10 more)

### Community 48 - "Community 48"
Cohesion: 0.27
Nodes (18): applyTaskbarEnabled(), getTaskbarConfig(), isTaskbarWidgetEnabled(), paintTaskbarPreview(), pushTaskbarState(), renderTaskbarPanel(), TASKBAR_COLOR_PRESETS, TASKBAR_DEFAULTS (+10 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (15): ensureStream(), log, safeJson(), write(), FFmpegRawProgress, parseProgress(), RunHandle, RunOptions (+7 more)

### Community 50 - "Community 50"
Cohesion: 0.14
Nodes (8): metadata, alt, contentType, runtime, size, SITE, SITE_URL, VERSION_LABEL

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (15): neutralFilters(), buildAudioChain(), buildVideoChain(), ChainOptions, clamp(), denoiseFilterString(), hqdn3dParams(), nlmeansParams() (+7 more)

### Community 52 - "Community 52"
Cohesion: 0.17
Nodes (12): allowedAudiences, dynamic, googleClient, runtime, createVerifyResponse(), dynamic, GET(), getProvidedSecret() (+4 more)

### Community 53 - "Community 53"
Cohesion: 0.15
Nodes (10): calculateFps(), drawSpark(), getColor(), HISTORY, logBox, navItems, pages, runBoost() (+2 more)

### Community 54 - "Community 54"
Cohesion: 0.28
Nodes (15): applyDiscordRpcEnabled(), discordRpcCfg(), discordRpcCollect(), discordRpcElapsedText(), discordRpcOnEdit(), discordRpcPaint(), discordRpcPreviewHtml(), discordRpcReconnect() (+7 more)

### Community 55 - "Community 55"
Cohesion: 0.21
Nodes (13): addInputs(), AddOptions, broadcastJobs(), clearFinished(), getJob(), JobRunner, jobs, pump() (+5 more)

### Community 56 - "Community 56"
Cohesion: 0.32
Nodes (15): applyCrosshairEnabled(), chResetConfig(), chSetColorLive(), chSetOption(), chSetSlider(), chSetVisible(), CROSSHAIR_COLOR_PRESETS, CROSSHAIR_STYLES (+7 more)

### Community 57 - "Community 57"
Cohesion: 0.19
Nodes (11): esc(), flashStat(), getIconPath(), iconFileUrl(), launchApp(), loadSystemStats(), renderApps(), showToast() (+3 more)

### Community 58 - "Community 58"
Cohesion: 0.13
Nodes (15): files, crosshair-overlay.html, crosshair-overlay-preload.js, icons/**/*, license-gate.html, license-gate-preload.js, logger.js, main/**/* (+7 more)

### Community 59 - "Community 59"
Cohesion: 0.25
Nodes (14): bundledDir(), capsSufficient(), detectCapabilities(), download(), ensureToolchain(), findFileRecursive(), findOnPath(), Listener (+6 more)

### Community 60 - "Community 60"
Cohesion: 0.17
Nodes (11): ffmpeg-static, author, dependencies, ffmpeg-static, description, keywords, license, main (+3 more)

### Community 61 - "Community 61"
Cohesion: 0.17
Nodes (10): crypto, DEFAULT_SETTINGS, DEFAULT_TIKTOK_SPEC, fs, https, { ipcMain, dialog, shell }, os, path (+2 more)

### Community 62 - "Community 62"
Cohesion: 0.17
Nodes (12): build, appId, asarUnpack, directories, portable, productName, win, buildResources (+4 more)

### Community 63 - "Community 63"
Cohesion: 0.30
Nodes (10): applyParallaxPref(), PARALLAX_DEPTHS, parallaxApply(), parallaxBackdropActive(), parallaxClear(), parallaxKick(), parallaxLayers(), parallaxReturnToCenter() (+2 more)

### Community 64 - "Community 64"
Cohesion: 0.35
Nodes (10): fs, getConfigPath(), getWindowPosition(), init(), listDisplaysForUI(), path, readSelectedDisplayId(), resolveTargetDisplay() (+2 more)

### Community 65 - "Community 65"
Cohesion: 0.27
Nodes (6): clipboardEntryBody(), clipboardEntryMeta(), clipboardFileName(), clipboardPreview(), refreshClipboardData(), renderClipboardPanel()

### Community 66 - "Community 66"
Cohesion: 0.36
Nodes (10): getWeatherEnhCity(), isWeatherEnhancedEnabled(), renderWeatherEnhancedPanel(), WEATHER_ENH_ICONS, weatherEnhDayLabel(), weatherEnhIcon(), weatherEnhRefresh(), weatherEnhSetCity() (+2 more)

### Community 67 - "Community 67"
Cohesion: 0.29
Nodes (9): clampStr(), crypto, fs, init(), { ipcMain }, net, path, sanitizeButtons() (+1 more)

### Community 68 - "Community 68"
Cohesion: 0.24
Nodes (9): ACTION_KEYS, { app, ipcMain }, { ensureVersionedScript }, fs, init(), newRuleId(), path, sanitizeRule() (+1 more)

### Community 69 - "Community 69"
Cohesion: 0.22
Nodes (9): devDependencies, electron, electron-builder, @fortawesome/fontawesome-free, tailwindcss, electron, electron-builder, @fortawesome/fontawesome-free (+1 more)

### Community 70 - "Community 70"
Cohesion: 0.31
Nodes (5): closeLogoutModal(), confirmLogout(), loadAccountInfo(), maskLicenseKey(), recheckLicense()

### Community 71 - "Community 71"
Cohesion: 0.22
Nodes (8): ButtonAsButton, ButtonAsLink, ButtonProps, CommonProps, Size, sizes, Variant, variants

### Community 72 - "Community 72"
Cohesion: 0.25
Nodes (8): nsis, allowToChangeInstallationDirectory, artifactName, createDesktopShortcut, createStartMenuShortcut, oneClick, perMachine, shortcutName

### Community 73 - "Community 73"
Cohesion: 0.32
Nodes (3): metadata, metadata, LegalPage()

### Community 74 - "Community 74"
Cohesion: 0.29
Nodes (5): crypto, { execFile }, fs, { ipcMain, clipboard, nativeImage }, path

### Community 75 - "Community 75"
Cohesion: 0.52
Nodes (5): baseNameNoExt(), NamingOptions, outputPathFor(), splitPath(), stripOutputSuffix()

### Community 76 - "Community 76"
Cohesion: 0.33
Nodes (5): { app, BrowserWindow, ipcMain, globalShortcut, screen }, { ensureVersionedScript }, init(), path, { runCmd }

### Community 77 - "Community 77"
Cohesion: 0.47
Nodes (5): getCpuUsagePercent(), init(), { ipcMain }, os, sampleCpu()

### Community 78 - "Community 78"
Cohesion: 0.33
Nodes (3): DEFAULT_HOTKEYS, MINI_WIDGET_CATEGORIES, MINI_WIDGETS

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (5): scripts, build, build:css, start, test

### Community 80 - "Community 80"
Cohesion: 0.40
Nodes (3): contentType, runtime, size

### Community 81 - "Community 81"
Cohesion: 0.40
Nodes (4): JWT, next-auth, next-auth/jwt, Session

### Community 83 - "Community 83"
Cohesion: 0.50
Nodes (3): backgroundsBasePath, { contextBridge, ipcRenderer, webUtils }, iconsBasePath

## Knowledge Gaps
- **569 isolated node(s):** `{ contextBridge, ipcRenderer }`, `{ app, BrowserWindow, ipcMain, screen }`, `path`, `{ exec, execSync }`, `si` (+564 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ensureVersionedScript()` connect `Community 22` to `Controller Macros (Main)`, `Community 20`, `Community 76`, `Community 68`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Why does `runCmd()` connect `Community 20` to `Community 43`, `Community 76`, `Community 22`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **What connects `{ contextBridge, ipcRenderer }`, `{ app, BrowserWindow, ipcMain, screen }`, `path` to the rest of the system?**
  _569 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Controller Macros (UI)` be split into smaller, more focused modules?**
  _Cohesion score 0.06335403726708075 - nodes in this community are weakly interconnected._
- **Should `ValClips Quality UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06790890269151138 - nodes in this community are weakly interconnected._
- **Should `ValClips Panel` be split into smaller, more focused modules?**
  _Cohesion score 0.06308610400682012 - nodes in this community are weakly interconnected._
- **Should `Background & Themes` be split into smaller, more focused modules?**
  _Cohesion score 0.09195402298850575 - nodes in this community are weakly interconnected._