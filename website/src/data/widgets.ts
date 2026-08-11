/**
 * The 19 real mini widgets, mirrored from the app's MINI_WIDGETS registry
 * (main-app11/main-app/renderer/core.js — the single source of truth). Names,
 * categories, icons, descriptions, versions and keywords are copied so the
 * #widgets grid stays in lockstep with the app.
 */
export type WidgetCategory =
  | "Audio"
  | "Productivity"
  | "Gaming"
  | "Clipboard"
  | "Spotify"
  | "Displays"
  | "System"
  | "Searching"
  | "Media"
  | "Weather"
  | "Utilities"
  | "Social";

export type Widget = {
  id: string;
  name: string;
  category: WidgetCategory;
  icon: string;
  iconStyle?: "fas" | "fab";
  description: string;
  features: string[];
  version: string;
  keywords: string[];
  defaultHotkey?: string;
};

export const WIDGETS: Widget[] = [
  {
    id: "micMute",
    name: "Mic Mute",
    category: "Audio",
    icon: "fa-microphone",
    description:
      "Mute your microphone system-wide with a hotkey, with an on-screen status overlay even outside the app.",
    features: [
      "System-wide mute hotkey",
      "Always-on-top status overlay",
      "Works outside the app",
    ],
    version: "1.0.0",
    keywords: ["mic", "microphone", "mute", "voice", "push to talk", "overlay"],
    defaultHotkey: "Control+Shift+M",
  },
  {
    id: "macros",
    name: "Macros",
    category: "Productivity",
    icon: "fa-keyboard",
    description:
      "Record & replay mouse/keyboard actions system-wide; per-macro hotkeys with Pressed/Hold/Toggle/Released modes, repeat counts and playback speed.",
    features: [
      "Record mouse & keyboard",
      "Per-macro hotkeys",
      "Pressed / Hold / Toggle / Released",
      "Repeat counts & speed",
    ],
    version: "1.0.0",
    keywords: ["macro", "automation", "keyboard", "mouse", "record", "replay"],
  },
  {
    id: "controllerMacros",
    name: "Controller Macros",
    category: "Gaming",
    icon: "fa-gamepad",
    description:
      "Map controller inputs and stick movements to macros with a visual joystick editor — combos games really see.",
    features: [
      "Virtual PlayStation / Xbox 360 pad",
      "Visual 8-way joystick editor",
      "Skate & NBA 2K26 template libraries",
      "Record combos from a real pad",
    ],
    version: "1.2.0",
    keywords: [
      "controller",
      "gamepad",
      "playstation",
      "xbox",
      "combo",
      "stick",
      "joystick",
      "vigem",
    ],
  },
  {
    id: "clipboard",
    name: "Clipboard History",
    category: "Clipboard",
    icon: "fa-clipboard",
    description:
      "A running history of everything you copy — text, images and files — to re-copy, pin or delete.",
    features: [
      "Tracks text, images & files",
      "Re-copy any past item",
      "Pin favourites",
      "Delete individual entries",
    ],
    version: "1.0.0",
    keywords: ["clipboard", "copy", "paste", "history", "snippets"],
  },
  {
    id: "spotifyEnhanced",
    name: "Spotify Enhanced",
    category: "Spotify",
    icon: "fa-headphones",
    description:
      "Queue viewer, playlist shortcuts, recently played, and one-click like/unlike on the player.",
    features: [
      "Queue viewer",
      "Playlist shortcuts",
      "Recently played",
      "One-click like / unlike",
    ],
    version: "1.0.0",
    keywords: ["spotify", "music", "queue", "playlist", "like", "player"],
  },
  {
    id: "screenResolution",
    name: "Screen Resolution",
    category: "Displays",
    icon: "fa-display",
    description:
      "Detect & switch each monitor's resolution and refresh rate; favourites; auto-revert unsupported switches after 15s.",
    features: [
      "Per-monitor resolution & refresh rate",
      "Favourite your most-used modes",
      "Auto-revert unsupported switches",
    ],
    version: "1.0.0",
    keywords: ["display", "monitor", "resolution", "refresh rate", "hz"],
  },
  {
    id: "bluetooth",
    name: "Bluetooth Manager",
    category: "System",
    icon: "fa-bluetooth-b",
    iconStyle: "fab",
    description:
      "Full Bluetooth control centre: toggle the radio, see paired devices with battery/status, connect/disconnect/remove, scan & pair, favourites, auto-reconnect.",
    features: [
      "Turn the Bluetooth radio on / off",
      "Connect / disconnect paired devices",
      "Device type, battery & last-used",
      "Favourites with auto-reconnect",
    ],
    version: "2.0.0",
    keywords: ["bluetooth", "device", "headphones", "pair", "battery", "radio"],
  },
  {
    id: "claudeLimit",
    name: "Claude Limit Auto-Continue",
    category: "Productivity",
    icon: "fa-robot",
    description:
      "Waits out a Claude usage limit and auto-continues the chat when it resets — never bypasses a limit.",
    features: [
      "Detects reset time from message or clipboard",
      "Counts down and auto-continues",
      "Sends your prompt into any window",
      "Manual time or countdown",
    ],
    version: "1.0.0",
    keywords: ["claude", "limit", "usage", "reset", "continue", "auto", "anthropic"],
  },
  {
    id: "fileSearch",
    name: "File Search",
    category: "Searching",
    icon: "fa-magnifying-glass",
    description:
      "Fast local filename search across your folders — instant, in-memory, like voidtools Everything.",
    features: [
      "Instant in-memory filename search",
      "Index the folders/drives you choose",
      "Wildcards, ext:, size:, path:, regex:",
      "Open file, open folder, copy path",
    ],
    version: "1.0.0",
    keywords: ["file", "search", "find", "everything", "index", "regex"],
  },
  {
    id: "videoEditor",
    name: "Video Editor",
    category: "Media",
    icon: "fa-film",
    description:
      "Fast video trimmer: set in/out points, keep/drop audio, lossless or frame-accurate export, bundled FFmpeg.",
    features: [
      "Timeline in/out trimming",
      "Keep or drop audio",
      "Lossless or frame-accurate export",
      "Bundled FFmpeg",
    ],
    version: "1.0.0",
    keywords: ["video", "editor", "trim", "clip", "ffmpeg", "export"],
  },
  {
    id: "valclips",
    name: "ValClips Quality",
    category: "Media",
    icon: "fa-wand-magic-sparkles",
    description:
      "TikTok/clip optimiser: size-cap default, chroma boost, VMAF-verified encodes, own bundled FFmpeg.",
    features: [
      "Drop-and-go Express pipeline",
      "VMAF + SSIM verified encodes",
      "Lossless remux when possible",
      "Before/after Tune preview",
    ],
    version: "1.2.0",
    keywords: ["valorant", "tiktok", "clip", "quality", "encode", "vmaf", "ffmpeg"],
  },
  {
    id: "crosshair",
    name: "Crosshair",
    category: "Gaming",
    icon: "fa-crosshairs",
    description:
      "Draws a customizable crosshair centered above every window; style, color, size, gap, opacity; hotkey toggle.",
    features: [
      "Always-on-top centre crosshair",
      "Style, colour, size, gap & opacity",
      "Toggle with a hotkey",
    ],
    version: "1.0.0",
    keywords: ["crosshair", "aim", "reticle", "fps", "valorant", "overlay"],
    defaultHotkey: "Control+Shift+X",
  },
  {
    id: "weatherEnhanced",
    name: "Weather Enhanced",
    category: "Weather",
    icon: "fa-cloud-sun-rain",
    description:
      "Full detail panel: feels-like, humidity, wind, 3-day forecast; auto-location or pinned city.",
    features: [
      "Feels-like, humidity & wind",
      "3-day forecast",
      "Manual city override",
      "Follows your °C/°F setting",
    ],
    version: "1.0.0",
    keywords: ["weather", "forecast", "humidity", "wind", "city", "rain"],
  },
  {
    id: "timer",
    name: "Countdown Timer",
    category: "Productivity",
    icon: "fa-hourglass-half",
    description:
      "Presets or custom duration with a header live readout, sound + toast on finish.",
    features: [
      "Countdown to zero",
      "Quick presets + custom duration",
      "Live header readout",
      "Sound + toast when time is up",
    ],
    version: "1.0.0",
    keywords: ["timer", "countdown", "pomodoro", "alarm", "reminder"],
  },
  {
    id: "notesEnhanced",
    name: "Quick Notes Enhanced",
    category: "Productivity",
    icon: "fa-note-sticky",
    description:
      "Multi-note tabs, checklists, Markdown preview, per-note version history.",
    features: [
      "Multiple notes in tabs",
      "Checklist mode",
      "Live Markdown preview",
      "Per-note version history",
    ],
    version: "1.0.0",
    keywords: ["notes", "todo", "checklist", "markdown", "tabs", "history"],
  },
  {
    id: "launchEnhanced",
    name: "Quick Launch Enhanced",
    category: "Utilities",
    icon: "fa-rocket",
    description:
      "Folders, auto-detect Steam/Epic games, multi-app launch profiles, running indicators.",
    features: [
      "Folders / groups (Games, Work, custom)",
      "Auto-detect Steam & Epic games",
      "Launch profiles",
      "Running-app indicator dots",
    ],
    version: "1.0.0",
    keywords: ["launch", "apps", "games", "steam", "epic", "folders", "profiles"],
  },
  {
    id: "gameMode",
    name: "Game Mode",
    category: "Gaming",
    icon: "fa-gamepad",
    description:
      "Detects when a game launches and automatically runs the actions you choose — mic, crosshair, FPS, more.",
    features: [
      "Detects a named or fullscreen game",
      "Per-game action profiles",
      "Auto-enable other mini widgets",
      "Undo everything when the game closes",
    ],
    version: "1.0.0",
    keywords: ["game", "fullscreen", "detect", "profile", "automation", "trigger"],
  },
  {
    id: "volumeMixer",
    name: "Volume Mixer",
    category: "Audio",
    icon: "fa-sliders",
    description:
      "Per-app volume mixer with master control and optional global hotkeys.",
    features: [
      "Per-app volume & mute",
      "Master output volume & mute",
      "Live session list",
      "Global master-volume hotkeys",
    ],
    version: "1.0.0",
    keywords: ["volume", "mixer", "audio", "sound", "per-app", "master", "mute"],
  },
  {
    id: "discordRpc",
    name: "Discord Rich Presence",
    category: "Social",
    icon: "fa-discord",
    iconStyle: "fab",
    description:
      "Custom Discord Rich Presence card with images, buttons, elapsed clock, live preview.",
    features: [
      "Custom details, state & images",
      "Up to two link buttons",
      "Elapsed-time clock",
      "Live preview card",
    ],
    version: "1.0.0",
    keywords: ["discord", "rich presence", "rpc", "status", "playing", "activity"],
  },
];

/** Categories that actually have widgets, in display order. */
export const WIDGET_CATEGORIES: WidgetCategory[] = Array.from(
  new Set(WIDGETS.map((w) => w.category)),
) as WidgetCategory[];
