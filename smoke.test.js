'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeEvent, normalizeTimer } = require('../src/normalize');
const { Store } = require('../src/store');
const { LocalServer } = require('../src/server');

const resources = {
  DatabaseHunt: {
    'S Test Hunt': { Rank: 5, Region: 'Central Shroud', Patch: 'ARR', RespawnTimer: [84, 132], MaintTimer: [50, 80] },
    'A Test Hunt': { Rank: 1, Region: 'La Noscea', Patch: 'ARR', RespawnTimer: [4, 6], MaintTimer: [4, 8] }
  },
  DataCenters: { '陆行鸟': { Names: ['红玉海', '神意之地'] } }
};

test('normalizeEvent maps Rank=5 to S and normalizes unix seconds', () => {
  const event = normalizeEvent('DeathReport', {
    Hunt: 'S Test Hunt', World: '红玉海', Time: 1700000000,
    LastMarkTime: 1700000000, MaintState: false
  }, resources);
  assert.equal(event.type, 'death');
  assert.equal(event.rank, 's');
  assert.equal(event.time, 1700000000);
  assert.equal(event.window.minHours, 84);
  assert.equal(event.window.maxHours, 132);
});

test('normalizeTimer derives window using MaintTimer when maintenance is active', () => {
  const timer = normalizeTimer({
    huntName: 'S Test Hunt', worldName: '红玉海', lastDeathTime: 1700000000,
    lastMarkTime: 1700000000, isMaint: true
  }, resources);
  assert.equal(timer.rank, 's');
  assert.equal(timer.window.minHours, 50);
  assert.equal(timer.window.maxHours, 80);
});

test('Store does not let an older timer overwrite newer state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-bridge-test-'));
  const store = new Store({ dataDir: dir });
  const keyOf = (world, hunt) => `${world}|${hunt}`;
  store.applyTimers([{ worldName: '红玉海', huntName: 'S Test Hunt', lastDeathTime: 200, rank: 's' }], keyOf);
  store.applyTimers([{ worldName: '红玉海', huntName: 'S Test Hunt', lastDeathTime: 100, rank: 's' }], keyOf);
  assert.equal(store.loadState().hunts['红玉海|S Test Hunt'].lastDeathTime, 200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Local API maps configured hunt aliases and rejects unmapped Chinese names', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-bridge-http-'));
  const calls = [];
  const cfg = {
    dataDir: dir,
    aliases: { '伊休妲': 'S Test Hunt' },
    sync: { allowUpstreamReports: true, queueTransientFailures: true, maxOutboxAttempts: 3 },
    local: { host: '127.0.0.1', port: 0, allowedOrigins: ['null'], webhookUrl: '' }
  };
  const store = new Store(cfg);
  const socket = { connected: false, rooms: ['陆行鸟'], setRooms() {} };
  const rest = { async reportDeath(payload) { calls.push(payload); return { status: 200, json: { ok: true } }; } };
  const server = new LocalServer({ cfg, rest, store, socket, log() {}, getStatus: () => ({ authenticated: true }) }).start();
  t.after(() => { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const health = await fetch(`${base}/health`).then(r => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.authenticated, true);

  const good = await fetch(`${base}/report/death`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ huntName: '伊休妲', worldName: '红玉海', reportTime: 1700000000 })
  });
  assert.equal(good.status, 200);
  assert.equal(calls[0].huntName, 'S Test Hunt');

  const missing = await fetch(`${base}/report/death`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ huntName: '未配置的怪物', worldName: '红玉海', reportTime: 1700000000 })
  });
  assert.equal(missing.status, 400);
  assert.equal(calls.length, 1);
});


test('normalizeEvent uses explicit LastDeath for SRankFATEUpdate', () => {
  const event = normalizeEvent('SRankFATEUpdate', {
    Hunt: 'S Test Hunt', World: '红玉海', LastSeen: 1700000100, LastDeath: 1700000000
  }, resources);
  assert.equal(event.type, 'srank_fate');
  assert.equal(event.rank, 's');
  assert.equal(event.lastDeath, 1700000000);
  assert.equal(event.time, 1700000000);
});

test('toolbox local login endpoint forwards credentials only to the in-memory handler', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-bridge-login-'));
  let received = null;
  const cfg = {
    dataDir: dir, aliases: {}, sync: { allowUpstreamReports: true, queueTransientFailures: true, maxOutboxAttempts: 3 },
    local: { host: '127.0.0.1', port: 0, allowedOrigins: ['null'], webhookUrl: '' }
  };
  const store = new Store(cfg);
  const socket = { connected: false, rooms: [], setRooms() {} };
  const rest = {};
  const server = new LocalServer({
    cfg, rest, store, socket, log() {},
    authenticate: async credentials => {
      received = credentials;
      return { username: credentials.username, authenticated: true, permissions: ['hunt-report'] };
    },
    getStatus: () => ({ authenticated: !!received, username: received?.username || null })
  }).start();
  t.after(() => { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo-user', password: 'demo-password' })
  });
  assert.equal(response.status, 200);
  assert.equal(received.username, 'demo-user');
  assert.equal(received.password, 'demo-password');
  const body = await response.json();
  assert.equal(body.authenticated, true);
  assert.deepEqual(body.permissions, ['hunt-report']);
});

test('normalizeHuntInfo reads an anonymous previousDeath timestamp for Rank=5 S monsters', () => {
  const { normalizeHuntInfo } = require('../src/normalize');
  const normalized = normalizeHuntInfo('S Test Hunt', '红玉海', {
    previousDeath: { ReportTime: 1700000000000, Missing: 0 },
    previousState: 'dead',
    count: 12
  }, resources.DatabaseHunt['S Test Hunt']);
  assert.equal(normalized.rank, 's');
  assert.equal(normalized.lastDeathTime, 1700000000);
  assert.equal(normalized.count, 12);
});

test('normalizeHuntInfo does not mistake previousState or count for a kill timestamp', () => {
  const { normalizeHuntInfo } = require('../src/normalize');
  const normalized = normalizeHuntInfo('S Test Hunt', '红玉海', {
    previousDeath: null,
    previousState: { state: 'alive', id: 1700000000 },
    count: 1700000000
  }, resources.DatabaseHunt['S Test Hunt']);
  assert.equal(normalized, null);
});

test('normalizeHuntInfo rejects A-rank rows even if they contain a timestamp', () => {
  const { normalizeHuntInfo } = require('../src/normalize');
  const normalized = normalizeHuntInfo('A Test Hunt', '红玉海', {
    previousDeath: 1700000000, previousState: 'dead', count: 3
  }, resources.DatabaseHunt['A Test Hunt']);
  assert.equal(normalized, null);
});

test('anonymous S-only bridge exposes only Rank=s cache and rejects upstream write routes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-bridge-anon-'));
  const cfg = {
    dataDir: dir,
    aliases: {},
    sync: { allowUpstreamReports: false, queueTransientFailures: false, maxOutboxAttempts: 0 },
    local: { host: '127.0.0.1', port: 0, allowedOrigins: ['null'], webhookUrl: '' }
  };
  const store = new Store(cfg);
  store.applyTimers([
    { huntName: 'S Test Hunt', worldName: '红玉海', rank: 's', lastDeathTime: 1700000000 },
    { huntName: 'A Test Hunt', worldName: '红玉海', rank: 'a', lastDeathTime: 1700000100 }
  ], (world, hunt) => `${world}|${hunt}`);
  const server = new LocalServer({
    cfg, rest: {}, store, socket: null, log() {},
    getStatus: () => ({ mode: 'anonymous-srank', authenticated: false, resourcesReady: true, sync: { status: 'completed' } })
  }).start();
  t.after(() => { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const onlyS = await fetch(`${base}/hunts?rank=s`).then(response => response.json());
  assert.equal(onlyS.count, 1);
  assert.equal(onlyS.hunts[0].rank, 's');

  let manualSyncRaised = false;
  server.once('manualSync', () => { manualSyncRaised = true; });
  const syncResponse = await fetch(`${base}/sync/now`, { method: 'POST' });
  assert.equal(syncResponse.status, 202);
  assert.equal(manualSyncRaised, true);

  const writeResponse = await fetch(`${base}/report/death`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ huntName: 'S Test Hunt', worldName: '红玉海' })
  });
  assert.equal(writeResponse.status, 401);
});

test('resource filter discards A/B/B+ and FATE; only Rank=5 S definitions remain', () => {
  const { filterSRankResources } = require('../src/resources');
  const filtered = filterSRankResources({
    DatabaseHunt: {
      'S Test Hunt': { Rank: 5 },
      'A Test Hunt': { Rank: 1 },
      'B Test Hunt': { Rank: 2 },
      'B+ Test Hunt': { Rank: 3 }
    },
    DatabaseFate: { 'FATE Test': {} },
    SpawnPoint: { 'S Test Hunt': {} },
    DataCenters: { '陆行鸟': { Names: ['红玉海'] } }
  });
  assert.deepEqual(Object.keys(filtered.DatabaseHunt), ['S Test Hunt']);
  assert.deepEqual(Object.keys(filtered), ['DatabaseHunt', 'DataCenters']);
});
