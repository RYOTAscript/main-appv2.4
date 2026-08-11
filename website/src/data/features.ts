/**
 * Core app features for the #features grid. Mirrors CLAUDE.md's feature list
 * and the app's real capabilities. `hotkeys` renders as JetBrains-Mono pills.
 */
export type Feature = {
  id: string;
  icon: string;
  iconStyle?: "fas" | "fab";
  title: string;
  description: string;
  tags?: string[];
  hotkeys?: string[];
  span?: boolean; // wide card (2 cols on lg)
};

export const FEATURES: Feature[] = [
  {
    id: "spotify",
    icon: "fa-spotify",
    iconStyle: "fab",
    title: "Spotify integration",
    description:
      "A full PKCE-OAuth player with a spinning vinyl disk, transport & volume, queue, beat-reactive glow, and a GPU audio visualizer — circular bars, waveform, aura or particles.",
    tags: ["PKCE OAuth", "Vinyl", "Visualizer", "Beat glow"],
    span: true,
  },
  {
    id: "lyrics",
    icon: "fa-align-left",
    title: "Live synced lyrics",
    description:
      "LRC-timed lyrics from lrclib.net that scroll in perfect sync with the track, with a full-screen lyrics view and adjustable anticipation timing.",
    tags: ["lrclib.net", "Full-screen"],
  },
  {
    id: "performance",
    icon: "fa-gauge-high",
    title: "Performance monitoring",
    description:
      "Live CPU, RAM and FPS with animated accent bars that breathe as your system works.",
    tags: ["CPU", "RAM", "FPS"],
  },
  {
    id: "fps",
    icon: "fa-bolt",
    title: "FPS Optimizer",
    description:
      "One-click Windows tweaks for more frames: Optimize, Discord-Only, Kill Everything, Battery Saver, and Restore Defaults.",
    tags: ["Optimize", "Discord-Only", "Kill Everything", "Restore"],
  },
  {
    id: "quicklaunch",
    icon: "fa-rocket",
    title: "Quick Launch",
    description:
      "Pin apps & games with custom icons. Folders, launch profiles, running indicators, and auto-detected Steam & Epic games.",
    tags: ["Steam", "Epic", "Profiles"],
  },
  {
    id: "notes",
    icon: "fa-note-sticky",
    title: "Quick Notes",
    description:
      "Persistent local notes right on the dashboard — tabs, checklists, Markdown preview and per-note history in the enhanced mode.",
    tags: ["Tabs", "Checklists", "Markdown"],
  },
  {
    id: "weather",
    icon: "fa-cloud-sun",
    title: "Weather & Clock",
    description:
      "A header readout plus a 3-day forecast panel with feels-like, humidity and wind. °C/°F and 12/24-hour, your call.",
    tags: ["3-day forecast", "°C/°F"],
  },
  {
    id: "hotkeys",
    icon: "fa-keyboard",
    title: "Global hotkeys",
    description:
      "System-wide media and app control from anywhere — bind your own keys for focus, playback and more.",
    hotkeys: ["Alt+M", "Ctrl+Shift+Space", "Alt+←", "Alt+→"],
  },
  {
    id: "background",
    icon: "fa-palette",
    title: "Background Studio",
    description:
      "Animated scenes, your own image/GIF/video wallpaper, accent theming, blur/brightness/saturation, film grain, vignette, grid and scanlines — plus a true frosted-glass transparent mode over your live desktop.",
    tags: ["Scenes", "Accent theme", "Frosted glass"],
    span: true,
  },
  {
    id: "overlay",
    icon: "fa-layer-group",
    title: "Always-on overlay",
    description:
      "Runs from the system tray as a fully-animated glass overlay with a parallax depth effect — always there, never in the way.",
    tags: ["System tray", "Parallax"],
  },
];
