// P2.5 — Game Mode rule matching (shared semantics, mac watcher).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchRule } = require('../main/gameModeMac.logic');

const OWN = ['launcher', 'electron', 'main'];
const procRule = { id: 'p1', match: 'process', processName: 'Valorant' };
const fsRule = { id: 'f1', match: 'fullscreen' };

test('process rule matches the frontmost app (case-insensitive)', () => {
  assert.equal(matchRule([procRule], 'Valorant', false, OWN), procRule);
  assert.equal(matchRule([procRule], 'valorant', false, OWN), procRule);
  assert.equal(matchRule([procRule], 'Safari', false, OWN), null);
});

test('fullscreen rule fires only when frontmost is fullscreen', () => {
  assert.equal(matchRule([fsRule], 'Anything', true, OWN), fsRule);
  assert.equal(matchRule([fsRule], 'Anything', false, OWN), null);
});

test('process rule beats a generic fullscreen rule', () => {
  const rules = [fsRule, procRule];
  assert.equal(matchRule(rules, 'Valorant', true, OWN), procRule);
});

test('never matches our own app', () => {
  assert.equal(matchRule([{ id: 'x', match: 'process', processName: 'main' }], 'main', true, OWN), null);
  assert.equal(matchRule([fsRule], 'Electron', true, OWN), null);
});

test('no foreground / no rules → null', () => {
  assert.equal(matchRule([procRule], '', false, OWN), null);
  assert.equal(matchRule([], 'Valorant', true, OWN), null);
  assert.equal(matchRule(null, 'Valorant', true, OWN), null);
});

test('first fullscreen rule wins among several', () => {
  const a = { id: 'a', match: 'fullscreen', name: 'first' };
  const b = { id: 'b', match: 'fullscreen', name: 'second' };
  assert.equal(matchRule([a, b], 'X', true, OWN), a);
});
