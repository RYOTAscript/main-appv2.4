// P2.4 — Homebrew Cask catalog for the macOS App Installer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAC_CASK_CATALOG, MAC_CASK_IDS } = require('../main/macCaskCatalog');

test('catalog is grouped and non-trivial', () => {
  assert.ok(MAC_CASK_CATALOG.length >= 5, 'several categories');
  for (const group of MAC_CASK_CATALOG) {
    assert.ok(group.category && Array.isArray(group.apps) && group.apps.length, `well-formed: ${group.category}`);
    for (const app of group.apps) {
      assert.ok(app.id && app.name, `app has id + name in ${group.category}`);
    }
  }
});

test('every cask id is a valid brew token (lowercase, no spaces/shell chars)', () => {
  for (const id of MAC_CASK_IDS) {
    assert.match(id, /^[a-z0-9][a-z0-9@._-]*$/, `safe cask id: ${id}`);
  }
});

test('cask ids are unique across the whole catalog', () => {
  const all = MAC_CASK_CATALOG.flatMap(c => c.apps.map(a => a.id));
  assert.equal(new Set(all).size, all.length, 'no duplicate ids');
  assert.equal(MAC_CASK_IDS.size, all.length, 'the flat id set matches');
});

test('MAC_CASK_IDS is the allow-list the installer validates against', () => {
  assert.ok(MAC_CASK_IDS.has('google-chrome'));
  assert.ok(MAC_CASK_IDS.has('visual-studio-code'));
  assert.ok(!MAC_CASK_IDS.has('rm -rf /'));
  assert.ok(!MAC_CASK_IDS.has(''));
});
