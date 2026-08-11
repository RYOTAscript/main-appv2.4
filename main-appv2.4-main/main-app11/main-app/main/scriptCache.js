const fs = require('fs');

// Several features generate a small helper script (PowerShell) on disk and only
// need to rewrite it when its own content actually changes. Bumping `version`
// is how each caller signals "the script content below changed" without having
// to diff file contents on every startup.
function ensureVersionedScript(scriptPath, version, content) {
  const versionFile = `${scriptPath}.version`;
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (fs.existsSync(scriptPath) && current === String(version)) return;

  fs.writeFileSync(scriptPath, content, 'utf8');
  fs.writeFileSync(versionFile, String(version), 'utf8');
}

module.exports = { ensureVersionedScript };
