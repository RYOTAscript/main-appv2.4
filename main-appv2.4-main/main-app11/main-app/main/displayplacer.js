// displayplacer (MIT) output parsing + set-spec building → the renderer's
// monitor shape. Pure + unit-tested. `displayplacer list` prints a block per
// display with a list of "mode N: res:WxH hz:R color_depth:D" lines (the active
// one tagged "<-- current mode"); `displayplacer "id:… res:… hz:… color_depth:…"`
// switches a display.

// Parse `displayplacer list` → [{ id, name, primary, current:{w,h,refresh}, modes:[{width,height,refresh,colorDepth}] }].
function parseDisplayplacerList(stdout) {
  const text = String(stdout || '');
  const blocks = text.split(/\n(?=Persistent screen id:)/);
  const monitors = [];

  for (const block of blocks) {
    const id = (block.match(/Persistent screen id:\s*(\S+)/) || [])[1];
    if (!id) continue;
    if (/Enabled:\s*false/i.test(block)) continue; // skip disabled displays
    const name = ((block.match(/Type:\s*(.+)/) || [])[1] || 'Display').trim();
    const primary = /Origin:[^\n]*main display/i.test(block);

    const modes = [];
    let current = null;
    const modeRe = /mode\s+\d+:\s*res:(\d+)x(\d+)\s+hz:(\d+)\s+color_depth:(\d+)([^\n]*)/g;
    let m;
    while ((m = modeRe.exec(block)) !== null) {
      const mode = { width: +m[1], height: +m[2], refresh: +m[3], colorDepth: +m[4] };
      modes.push(mode);
      if (/<--\s*current mode/.test(m[5])) current = { width: mode.width, height: mode.height, refresh: mode.refresh };
    }
    if (!current) {
      const rw = block.match(/Resolution:\s*(\d+)x(\d+)/);
      const hz = block.match(/Hertz:\s*(\d+)/);
      if (rw) current = { width: +rw[1], height: +rw[2], refresh: hz ? +hz[1] : 0 };
    }

    // Dedupe modes by resolution+refresh (displayplacer lists scaled duplicates).
    const seen = new Set();
    const uniq = [];
    for (const md of modes) {
      const k = `${md.width}x${md.height}@${md.refresh}`;
      if (!seen.has(k)) { seen.add(k); uniq.push(md); }
    }

    monitors.push({ id, name, primary, current, modes: uniq });
  }
  return monitors;
}

// The single argument passed to `displayplacer` to switch one display's mode.
function setModeArg(id, width, height, refresh, colorDepth = 8) {
  return `id:${id} res:${width}x${height} hz:${refresh} color_depth:${colorDepth}`;
}

// Find the color depth of a specific mode (for a faithful set), else 8.
function colorDepthFor(monitor, width, height, refresh) {
  if (!monitor || !Array.isArray(monitor.modes)) return 8;
  const mode = monitor.modes.find((m) => m.width === width && m.height === height && m.refresh === refresh);
  return (mode && mode.colorDepth) || 8;
}

module.exports = { parseDisplayplacerList, setModeArg, colorDepthFor };
