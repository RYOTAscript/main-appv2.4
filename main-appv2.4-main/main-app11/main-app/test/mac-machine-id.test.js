// Stage 6 — cross-platform machine fingerprint (license machine-binding).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mid = require('../main/machineId');

const WIN_REG = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid';

test('machineIdCommand per platform', () => {
  assert.equal(mid.machineIdCommand('win32'), WIN_REG);
  assert.equal(mid.machineIdCommand('darwin'), 'ioreg -rd1 -c IOPlatformExpertDevice');
  assert.equal(mid.machineIdCommand('linux'), null);
});

test('extractMachineId parses Windows reg output', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\...\\Cryptography\r\n    MachineGuid    REG_SZ    12345678-90ab-cdef-1234-567890abcdef\r\n';
  assert.equal(mid.extractMachineId('win32', out), '12345678-90ab-cdef-1234-567890abcdef');
});

test('extractMachineId parses macOS ioreg output', () => {
  const out = '  +-o MacBookPro18,3  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n';
  assert.equal(mid.extractMachineId('darwin', out), 'ABCDEF01-2345-6789-ABCD-EF0123456789');
});

test('extractMachineId returns empty on junk / unknown platform', () => {
  assert.equal(mid.extractMachineId('win32', 'no guid here'), '');
  assert.equal(mid.extractMachineId('darwin', ''), '');
  assert.equal(mid.extractMachineId('linux', 'whatever'), '');
});

test('firstPhysicalMac skips internal and all-zero MACs', () => {
  const nets = {
    lo0: [{ internal: true, mac: '00:00:00:00:00:00' }],
    en0: [{ internal: false, mac: '00:00:00:00:00:00' }, { internal: false, mac: 'a4:83:e7:11:22:33' }],
  };
  assert.equal(mid.firstPhysicalMac(nets), 'a4:83:e7:11:22:33');
  assert.equal(mid.firstPhysicalMac({}), '');
});

// ── Windows hash MUST be byte-identical to the pre-port implementation ──
test('Windows machine id is UNCHANGED (existing users are not logged out)', () => {
  const guid = '12345678-90ab-cdef-1234-567890abcdef';
  const got = mid.computeMachineId('win32', { execSync: () => `    MachineGuid    REG_SZ    ${guid}\r\n` });
  // Reconstruct the on-disk contract (namespace + slice) INDEPENDENTLY here, so
  // any drift in machineId.js fails this test.
  const expected = crypto.createHash('sha256').update(`main-license|${guid}`).digest('hex').slice(0, 32);
  assert.equal(got, expected);
  assert.equal(got.length, 32);
});

test('macOS machine id derives from IOPlatformUUID', () => {
  const uuid = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
  const got = mid.computeMachineId('darwin', { execSync: () => `"IOPlatformUUID" = "${uuid}"` });
  const expected = crypto.createHash('sha256').update(`main-license|${uuid}`).digest('hex').slice(0, 32);
  assert.equal(got, expected);
});

test('macOS id is stable across calls and distinguishes machines', () => {
  const mk = (uuid) => mid.computeMachineId('darwin', { execSync: () => `"IOPlatformUUID" = "${uuid}"` });
  assert.equal(mk('AAAA-1111'), mk('AAAA-1111'));    // deterministic
  assert.notEqual(mk('AAAA-1111'), mk('BBBB-2222'));  // per-machine
});

test('falls back to hostname|MAC when the OS command fails', () => {
  const deps = {
    execSync: () => { throw new Error('command not found'); },
    networkInterfaces: () => ({ en0: [{ internal: false, mac: 'a4:83:e7:11:22:33' }] }),
    hostname: () => 'macbook',
  };
  assert.equal(mid.rawMachineId('darwin', deps), 'macbook|a4:83:e7:11:22:33');
});

test('ultimate fallback to hostname when networkInterfaces also throws', () => {
  const deps = {
    execSync: () => { throw new Error('nope'); },
    networkInterfaces: () => { throw new Error('no net'); },
    hostname: () => 'host9',
  };
  assert.equal(mid.rawMachineId('linux', deps), 'host9');
});
