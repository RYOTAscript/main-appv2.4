// Platform gating for Mini Widgets (renderer side).
//
// Some widgets rely on Windows-only technology and cannot run on macOS:
//   • Translucent Taskbar  — macOS has no taskbar
//   • Windows Debloat      — removes Windows AppX packages
//   • App Installer        — winget-backed
//   • Deep Uninstaller     — Windows registry / winget uninstall model
//   • Controller Macros    — ViGEm virtual-gamepad kernel driver (Windows only)
//
// Each such entry in the MINI_WIDGETS registry (renderer/core.js) carries a
// `platforms` array, e.g. `platforms: ['win32']`:
//   • no `platforms` field    → available on every OS
//   • `platforms: ['win32']`  → Windows only; hidden everywhere else
//
// The registry stays the full catalogue; the app filters it to the current OS
// ONCE, at load, so the Widget Library, dashboard strip, search index and the
// Settings summary all show the same OS-correct set (they all read the filtered
// MINI_WIDGETS). On Windows this is a no-op — every entry either omits
// `platforms` or lists 'win32'.
//
// Loaded two ways, so the pure functions take an explicit `platform` and never
// touch globals:
//   • renderer — as a <script> before core.js → exposes `window.WidgetPlatform`
//   • Node unit tests — via `require('../renderer/widget-platform.js')`
(function (root) {
  'use strict';

  var VALID_PLATFORMS = ['win32', 'darwin', 'linux'];

  // True when `widget` is allowed to run on `platform`. A missing, empty or
  // malformed `platforms` list means "all platforms" (fail-open — never hide a
  // widget because of bad metadata). Bad widget input is not "supported".
  function widgetSupportsPlatform(widget, platform) {
    if (!widget || typeof widget !== 'object') return false;
    var list = widget.platforms;
    if (list === undefined || list === null) return true;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.indexOf(platform) !== -1;
  }

  // Returns a NEW array with only the widgets available on `platform`. Never
  // mutates the input. Non-array input yields an empty array.
  function filterWidgetsForPlatform(widgets, platform) {
    if (!Array.isArray(widgets)) return [];
    return widgets.filter(function (w) { return widgetSupportsPlatform(w, platform); });
  }

  // Best-effort read of the running OS in the renderer. Defaults to 'win32'
  // (the app's original, Windows-only target) if the preload bridge hasn't
  // exposed a platform — so a missing value can NEVER accidentally hide the full
  // Windows catalogue. In Node (tests) there is no electronAPI → also 'win32'.
  function currentPlatform() {
    try {
      if (root && root.electronAPI && typeof root.electronAPI.platform === 'string') {
        return root.electronAPI.platform;
      }
    } catch (e) { /* ignore */ }
    return 'win32';
  }

  var api = {
    VALID_PLATFORMS: VALID_PLATFORMS,
    widgetSupportsPlatform: widgetSupportsPlatform,
    filterWidgetsForPlatform: filterWidgetsForPlatform,
    currentPlatform: currentPlatform
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;        // Node (unit tests)
  }
  if (root) root.WidgetPlatform = api;   // Renderer → window.WidgetPlatform
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
