// P2.5 — Free Up & Quiet: app-list parsing + quit-plan safety.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../main/macFreeUp.logic');

test('parseAppList splits the System Events comma list', () => {
  assert.deepEqual(L.parseAppList('Safari, Google Chrome, Notes'), ['Safari', 'Google Chrome', 'Notes']);
  assert.deepEqual(L.parseAppList(''), []);
  assert.deepEqual(L.parseAppList('  Finder  '), ['Finder']);
});

test('quitPlan excludes protected apps (case-insensitive)', () => {
  const running = ['Safari', 'Finder', 'Google Chrome', 'main'];
  const plan = L.quitPlan(running, [...L.BASE_PROTECTED, 'main'], null);
  assert.ok(plan.includes('Safari'));
  assert.ok(plan.includes('Google Chrome'));
  assert.ok(!plan.includes('Finder'), 'Finder is protected');
  assert.ok(!plan.includes('main'), 'the launcher is protected');
});

test('quitPlan excludes the frontmost app (the one you are using)', () => {
  const running = ['Safari', 'Notes', 'Terminal'];
  const plan = L.quitPlan(running, L.BASE_PROTECTED, 'Terminal');
  assert.deepEqual(plan.sort(), ['Notes', 'Safari']);
});

test('quitPlan handles empty input', () => {
  assert.deepEqual(L.quitPlan([], L.BASE_PROTECTED, null), []);
  assert.deepEqual(L.quitPlan(null, null, null), []);
});

test('BASE_PROTECTED covers Finder + core UI processes', () => {
  for (const p of ['finder', 'dock', 'systemuiserver', 'loginwindow']) {
    assert.ok(L.BASE_PROTECTED.includes(p), `${p} protected`);
  }
});
