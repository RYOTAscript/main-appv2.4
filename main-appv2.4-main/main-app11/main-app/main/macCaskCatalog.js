// Curated Homebrew Cask catalog for the macOS App Installer. Pure data. Each id
// is an EXACT `brew install --cask <id>` token from the official homebrew-cask
// tap — apps download from their real publishers (like winget on Windows), and
// only ids present here are ever passed to brew (validated backend-side), so no
// arbitrary string reaches a shell. Grouped like the Windows installer.
const MAC_CASK_CATALOG = [
  { category: 'Web Browsers', apps: [
    { id: 'google-chrome', name: 'Chrome' },
    { id: 'firefox', name: 'Firefox' },
    { id: 'brave-browser', name: 'Brave' },
    { id: 'arc', name: 'Arc' },
    { id: 'microsoft-edge', name: 'Edge' },
  ] },
  { category: 'Messaging', apps: [
    { id: 'discord', name: 'Discord' },
    { id: 'zoom', name: 'Zoom' },
    { id: 'slack', name: 'Slack' },
    { id: 'telegram', name: 'Telegram' },
    { id: 'signal', name: 'Signal' },
    { id: 'whatsapp', name: 'WhatsApp' },
  ] },
  { category: 'Media', apps: [
    { id: 'vlc', name: 'VLC' },
    { id: 'spotify', name: 'Spotify' },
    { id: 'iina', name: 'IINA' },
    { id: 'handbrake', name: 'HandBrake' },
    { id: 'audacity', name: 'Audacity' },
    { id: 'obs', name: 'OBS Studio' },
  ] },
  { category: 'Productivity', apps: [
    { id: 'notion', name: 'Notion' },
    { id: 'obsidian', name: 'Obsidian' },
    { id: 'rectangle', name: 'Rectangle' },
    { id: 'raycast', name: 'Raycast' },
    { id: 'alfred', name: 'Alfred' },
  ] },
  { category: 'Developer', apps: [
    { id: 'visual-studio-code', name: 'VS Code' },
    { id: 'iterm2', name: 'iTerm2' },
    { id: 'warp', name: 'Warp' },
    { id: 'docker', name: 'Docker' },
    { id: 'sublime-text', name: 'Sublime Text' },
    { id: 'github', name: 'GitHub Desktop' },
  ] },
  { category: 'Utilities', apps: [
    { id: 'the-unarchiver', name: 'The Unarchiver' },
    { id: 'appcleaner', name: 'AppCleaner' },
    { id: 'keka', name: 'Keka' },
    { id: 'stats', name: 'Stats' },
    { id: 'hiddenbar', name: 'Hidden Bar' },
  ] },
  { category: 'Creative', apps: [
    { id: 'gimp', name: 'GIMP' },
    { id: 'inkscape', name: 'Inkscape' },
    { id: 'blender', name: 'Blender' },
    { id: 'figma', name: 'Figma' },
  ] },
  { category: 'Cloud & Security', apps: [
    { id: 'google-drive', name: 'Google Drive' },
    { id: 'dropbox', name: 'Dropbox' },
    { id: '1password', name: '1Password' },
    { id: 'bitwarden', name: 'Bitwarden' },
  ] },
];

// Flat set of every valid cask id — the allow-list the installer validates against.
const MAC_CASK_IDS = new Set(MAC_CASK_CATALOG.flatMap((c) => c.apps.map((a) => a.id)));

module.exports = { MAC_CASK_CATALOG, MAC_CASK_IDS };
