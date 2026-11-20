'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isAppStorageKey, isSensitiveStorageKey, sanitizeEntries,
  validateLegacyBackup, buildBridgeConfig, resolveInside
} = require('../desktop-helpers');

test('only FF14-owned localStorage key prefixes are eligible for migration', () => {
  assert.equal(isAppStorageKey('ff14_all_kill_records'), true);
  assert.equal(isAppStorageKey('triggerMonitor.state'), true);
  assert.equal(isAppStorageKey('google_user_data'), false);
});

test('credentials and privilege markers are excluded from migration', () => {
  for (const key of ['ff14_password', 'ff14_apiToken', 'ff14_developer_mode', 'ff14_master_verified', 'ff14_csrf']) {
    assert.equal(isSensitiveStorageKey(key), true, key);
  }
  const safe = sanitizeEntries({
    ff14_all_kill_records: '[]',
    ff14_apiToken: 'do-not-copy',
    browser_other_site: 'do-not-copy',
    ff14_preferences: '{"theme":"dark"}'
  });
  assert.deepEqual(Object.keys(safe.entries).sort(), ['ff14_all_kill_records', 'ff14_preferences']);
  assert.equal(safe.skipped, 2);
});

test('legacy backup validator accepts schema v1 and strips unsafe entries', () => {
  const payload = validateLegacyBackup({
    schema: 'ff14-toolbox-local-backup', schemaVersion: 1, appVersion: '3.3.8',
    entries: { ff14_all_kill_records: '[]', ff14_developer_mode: 'true' }
  });
  assert.equal(payload.count, 1);
  assert.equal(payload.skipped, 1);
  assert.equal(payload.entries.ff14_all_kill_records, '[]');
});

test('legacy backup validator rejects unsupported schemas', () => {
  assert.throws(() => validateLegacyBackup({ schema: 'other', schemaVersion: 1, entries: {} }), /受支持/);
});

test('desktop bridge config is anonymous, read-only, and uses an app-specific data folder', () => {
  const cfg = buildBridgeConfig('C:/Users/Test/AppData/Roaming/ff14-srank-desktop');
  assert.equal(cfg.local.port, 8788);
  assert.deepEqual(cfg.local.allowedOrigins, ['app://bundle']);
  assert.equal(cfg.sync.allowUpstreamReports, false);
  assert.match(cfg.paths.dataDir, /bear-bridge-data$/);
  assert.equal(cfg.auth, undefined);
});

test('resource resolver blocks path traversal', () => {
  const root = path.resolve('/tmp/ff14-app');
  assert.equal(resolveInside(root, 'index.html'), path.join(root, 'index.html'));
  assert.throws(() => resolveInside(root, '../secret.txt'), /越界/);
});
