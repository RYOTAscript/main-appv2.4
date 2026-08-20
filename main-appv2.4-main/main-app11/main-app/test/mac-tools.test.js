// P2.4 — Homebrew tool helpers + blueutil (Bluetooth) builders/parsing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../main/macTools.helpers');
const bu = require('../main/blueutil');

// ── macTools.helpers ───────────────────────────────────────────────────
test('brew candidates cover Apple Silicon + Intel', () => {
  assert.deepEqual(H.BREW_CANDIDATES, ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
});

test('toolCandidates lists both brew prefixes', () => {
  assert.deepEqual(H.toolCandidates('blueutil'), ['/opt/homebrew/bin/blueutil', '/usr/local/bin/blueutil', '/usr/bin/blueutil']);
});

test('brew install command is the official brew.sh script, non-interactive', () => {
  assert.match(H.BREW_INSTALL_CMD, /NONINTERACTIVE=1/);
  assert.match(H.BREW_INSTALL_CMD, /raw\.githubusercontent\.com\/Homebrew\/install/);
});

test('brewInstallTerminalScript is valid, escaped AppleScript', () => {
  const s = H.brewInstallTerminalScript();
  assert.match(s, /tell application "Terminal" to do script /);
  // the inner double quotes of the shell command are backslash-escaped
  assert.match(s, /\\"/);
});

test('brew/cask install args', () => {
  assert.deepEqual(H.brewInstallArgs('blueutil'), ['install', 'blueutil']);
  assert.deepEqual(H.caskInstallArgs('google-chrome'), ['install', '--cask', 'google-chrome']);
});

test('parseWhich returns the first path line', () => {
  assert.equal(H.parseWhich('/opt/homebrew/bin/blueutil\n'), '/opt/homebrew/bin/blueutil');
  assert.equal(H.parseWhich(''), '');
});

// ── blueutil ───────────────────────────────────────────────────────────
test('blueutil arg builders', () => {
  assert.deepEqual(bu.powerGetArgs(), ['--power']);
  assert.deepEqual(bu.powerSetArgs(true), ['--power', '1']);
  assert.deepEqual(bu.powerSetArgs(false), ['--power', '0']);
  assert.deepEqual(bu.pairedJsonArgs(), ['--paired', '--format', 'json']);
  assert.deepEqual(bu.inquiryJsonArgs(5), ['--inquiry', '5', '--format', 'json']);
  assert.deepEqual(bu.connectArgs('a4-83-e7-00-11-22'), ['--connect', 'a4-83-e7-00-11-22']);
  assert.deepEqual(bu.unpairArgs('a4-83-e7-00-11-22'), ['--unpair', 'a4-83-e7-00-11-22']);
});

test('parsePower maps 1/0 → on/off', () => {
  assert.equal(bu.parsePower('1\n'), 'on');
  assert.equal(bu.parsePower('0'), 'off');
});

test('parseDevices maps blueutil JSON → renderer device shape', () => {
  const json = JSON.stringify([
    { address: 'a4-83-e7-00-11-22', name: 'AirPods', connected: true, paired: true, recentAccessDate: '2026-08-19T10:00:00Z' },
    { address: 'b0-00-00-00-00-01', name: 'Keyboard', connected: false, paired: true },
    { name: 'no-address-skip' },
  ]);
  const devices = bu.parseDevices(json);
  assert.equal(devices.length, 2, 'device with no address is dropped');
  assert.deepEqual(devices[0], {
    address: 'a4-83-e7-00-11-22', name: 'AirPods', connected: true, paired: true,
    battery: null, type: null, lastUsed: '2026-08-19T10:00:00Z',
  });
  assert.equal(devices[1].connected, false);
  assert.equal(devices[1].lastUsed, null);
});

test('parseDevices tolerates junk', () => {
  assert.deepEqual(bu.parseDevices('not json'), []);
  assert.deepEqual(bu.parseDevices('{}'), []);
});

test('isValidAddress accepts hyphen/colon MACs, rejects junk', () => {
  assert.equal(bu.isValidAddress('a4-83-e7-00-11-22'), true);
  assert.equal(bu.isValidAddress('A4:83:E7:00:11:22'), true);
  assert.equal(bu.isValidAddress('nope'), false);
  assert.equal(bu.isValidAddress('a4-83-e7-00-11'), false); // too short
  assert.equal(bu.isValidAddress(''), false);
});
