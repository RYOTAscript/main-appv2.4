// blueutil (MIT) command builders + JSON parsing → the renderer's Bluetooth
// device shape. Pure + unit-tested. blueutil supports `--format json`, so the
// device list maps cleanly onto what renderer/bluetooth.js reads
// (address/name/connected/paired/lastUsed; battery/type aren't exposed → null).

function powerGetArgs() { return ['--power']; }
function powerSetArgs(on) { return ['--power', on ? '1' : '0']; }
function pairedJsonArgs() { return ['--paired', '--format', 'json']; }
function inquiryJsonArgs(seconds = 5) { return ['--inquiry', String(seconds), '--format', 'json']; }
function connectArgs(addr) { return ['--connect', addr]; }
function disconnectArgs(addr) { return ['--disconnect', addr]; }
function pairArgs(addr) { return ['--pair', addr]; }
function unpairArgs(addr) { return ['--unpair', addr]; }

// Map one blueutil JSON device to the renderer's shape.
function mapDevice(d) {
  return {
    address: d.address || '',
    name: d.name || d.address || 'Unknown device',
    connected: !!d.connected,
    paired: d.paired !== false,
    battery: null,                 // blueutil doesn't expose battery level
    type: null,
    lastUsed: d.recentAccessDate || null,
  };
}

function parseDevices(stdout) {
  let arr;
  try { arr = JSON.parse(stdout); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((d) => d && d.address).map(mapDevice);
}

function parsePower(stdout) { return String(stdout).trim() === '1' ? 'on' : 'off'; }

// blueutil accepts hyphen- or colon-separated MACs.
function isValidAddress(a) { return /^[0-9a-fA-F]{2}([-:][0-9a-fA-F]{2}){5}$/.test(String(a || '')); }

module.exports = {
  powerGetArgs, powerSetArgs, pairedJsonArgs, inquiryJsonArgs,
  connectArgs, disconnectArgs, pairArgs, unpairArgs,
  mapDevice, parseDevices, parsePower, isValidAddress,
};
