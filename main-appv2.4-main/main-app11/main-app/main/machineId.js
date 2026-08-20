const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Stable, non-PII hardware id used to bind a license token to this machine.
// Extracted from license.js so the pure parsing/hashing is unit-testable
// (dependency-injectable) without pulling in electron.
//
//   Windows : MachineGuid (HKLM\SOFTWARE\Microsoft\Cryptography) — survives app
//             reinstalls, changes only on OS reinstall.
//   macOS   : IOPlatformUUID (ioreg) — the equivalent stable hardware UUID.
//   else    : hostname + first physical MAC, else hostname.
//
// ⚠️ The Windows path MUST stay byte-identical (command + regex + hash), or every
// existing Windows user's machine id changes and they get logged out.

// The command that yields a stable hardware id for a platform (null → use the
// network-interface fallback directly).
function machineIdCommand(platform) {
  if (platform === 'win32') return 'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid';
  if (platform === 'darwin') return 'ioreg -rd1 -c IOPlatformExpertDevice';
  return null;
}

// Extract the raw id from the command output for a platform. '' if not found.
function extractMachineId(platform, out) {
  if (!out) return '';
  if (platform === 'win32') {
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    return m ? m[1] : '';
  }
  if (platform === 'darwin') {
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([\w-]+)"/i);
    return m ? m[1] : '';
  }
  return '';
}

// First non-internal, non-zero MAC across all interfaces (fallback fingerprint).
function firstPhysicalMac(nets) {
  for (const name of Object.keys(nets || {})) {
    for (const ni of nets[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return '';
}

// Compute the raw machine fingerprint string. `deps` lets tests inject
// execSync / networkInterfaces / hostname to exercise every OS branch.
function rawMachineId(platform = process.platform, deps = {}) {
  const exec = deps.execSync || execSync;
  const netifs = deps.networkInterfaces || os.networkInterfaces;
  const host = deps.hostname || os.hostname;

  let raw = '';
  const cmd = machineIdCommand(platform);
  if (cmd) {
    try {
      raw = extractMachineId(platform, exec(cmd, { encoding: 'utf8', windowsHide: true, timeout: 4000 }));
    } catch (e) {
      /* fall through to the network-interface fallback */
    }
  }
  if (!raw) {
    try {
      raw = `${host()}|${firstPhysicalMac(netifs())}`;
    } catch (e) {
      raw = host() || 'unknown';
    }
  }
  return raw;
}

// Final 32-char machine id: sha256 of a namespaced raw id. The namespace and
// slice length are part of the on-disk token contract — do not change them.
function computeMachineId(platform = process.platform, deps = {}) {
  const raw = rawMachineId(platform, deps);
  return crypto.createHash('sha256').update(`main-license|${raw}`).digest('hex').slice(0, 32);
}

module.exports = { machineIdCommand, extractMachineId, firstPhysicalMac, rawMachineId, computeMachineId };
