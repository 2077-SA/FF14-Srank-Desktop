#!/usr/bin/env node
'use strict';
/**
 * Anonymous S-rank-only Bear Tracker bridge.
 * - No Bear account, password, API token, Socket.IO, or upstream writes are used.
 * - Uses the public anonymous /api/huntInfo endpoint for Rank=5 S monsters only.
 * - Requests are throttled and processed with a small worker pool so the UI never waits
 *   for the remote scan; the local HTTP server is started before remote initialization.
 */
const path = require('node:path');
const config = require('./config');
const { TrackerRest } = require('./tracker-rest');
const { Store } = require('./store');
const { LocalServer, keyOf } = require('./server');
const { normalizeHuntInfo } = require('./normalize');
const { filterSRankResources } = require('./resources');

const cfg = config.load();
// Force the anonymous, read-only mode even when upgrading from an older login-capable config.
cfg.auth = { username: '', password: '', cookie: '', csrfToken: '', apiToken: '' };
cfg.sync = { ...(cfg.sync || {}), allowUpstreamReports: false, queueTransientFailures: false, maxOutboxAttempts: 0 };
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = message => console.log(`${stamp()} ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function worldsFor(resources) {
  if (Array.isArray(cfg.watch.worlds) && cfg.watch.worlds.length) return [...new Set(cfg.watch.worlds)];
  const worlds = [];
  for (const dc of cfg.watch.dataCenters || []) {
    const entry = resources?.DataCenters?.[dc];
    const names = entry?.Names || entry?.Worlds || entry?.worlds;
    if (Array.isArray(names)) worlds.push(...names);
  }
  return [...new Set(worlds)];
}

function mapToLocalName(name) {
  for (const [localName, trackerName] of Object.entries(cfg.aliases || {})) {
    if (trackerName === name) return localName;
  }
  return name;
}

async function getResources(rest, store) {
  const response = await rest.syncSession();
  const resources = response.json?.resources;
  if (response.status >= 400) {
    throw new Error(`匿名 syncSession 失败（HTTP ${response.status}）：${String(response.text || '').slice(0, 160)}`);
  }
  // Hard-filter the cache itself: this bridge intentionally discards every non-S dataset.
  const sOnlyResources = filterSRankResources(resources);
  store.saveResources(sOnlyResources);
  const sCount = Object.keys(sOnlyResources.DatabaseHunt).length;
  log(`[resources] 匿名 S 怪词库已就绪：仅保留 S 怪 ${sCount} 只；数据中心 ${Object.keys(sOnlyResources.DataCenters).length} 个`);
  return sOnlyResources;
}

function publicSyncState() {
  return {
    mode: 'anonymous-srank',
    status: 'starting',
    running: false,
    dataCenters: cfg.watch.dataCenters || [],
    rank: 's',
    totalTargets: 0,
    completed: 0,
    recordsFound: 0,
    noRecord: 0,
    errors: 0,
    lastSyncAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    lastError: null,
    resourcesReady: false
  };
}

async function runServe() {
  // Discard any stale authenticated session from an earlier bridge release. A fresh anonymous
  // session is created by GET /index and saved locally by TrackerRest.
  try { require('node:fs').rmSync(path.join(cfg.dataDir, 'auth-session.json'), { force: true }); } catch {}
  try { require('node:fs').rmSync(path.join(cfg.dataDir, 'cookies.json'), { force: true }); } catch {}
  const rest = new TrackerRest(cfg, log);
  const store = new Store(cfg);
  let resources = null;
  // If upgrading from an older all-rank bridge, sanitize its resource cache immediately.
  try {
    const cached = store.loadResources();
    if (cached) { resources = filterSRankResources(cached); store.saveResources(resources); }
  } catch (error) { log(`[resources] 已忽略旧版非 S 资源缓存：${error.message}`); }
  const syncState = publicSyncState();
  let syncPromise = null;
  let resourcesPromise = null;
  let remoteReady = false;

  async function ensureResources() {
    if (remoteReady && resources) return resources;
    if (resourcesPromise) return resourcesPromise;
    resourcesPromise = (async () => {
      const bootstrap = await rest.bootstrap();
      log(`[rest] 匿名会话已建立：csrf=${bootstrap.csrf ? 'ok' : 'missing'}，session=${bootstrap.hasSession ? 'ok' : 'missing'}`);
      resources = await getResources(rest, store);
      remoteReady = true;
      syncState.resourcesReady = true;
      syncState.status = 'ready';
      return resources;
    })().catch(error => {
      syncState.status = 'error';
      syncState.running = false;
      syncState.lastError = error.message;
      log(`[init] Bear Tracker 匿名资源初始化失败：${error.message}`);
      throw error;
    }).finally(() => { resourcesPromise = null; });
    return resourcesPromise;
  }

  const sRankDefinitions = () => Object.entries(resources?.DatabaseHunt || {})
    .filter(([, definition]) => Number(definition?.Rank) === 5)
    .map(([name, definition]) => ({ name, definition }));

  async function runAnonymousSRankSync(reason = 'manual') {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      if (!remoteReady || !resources) await ensureResources();
      const definitions = sRankDefinitions();
      const worlds = worldsFor(resources);
      if (!definitions.length) throw new Error('syncSession 中没有找到 Rank=5 的 S 怪词库。');
      if (!worlds.length) throw new Error('当前数据中心没有解析出服务器列表，请检查选择。');

      const tasks = [];
      for (const worldName of worlds) for (const item of definitions) tasks.push({ ...item, worldName });
      const started = Date.now();
      Object.assign(syncState, {
        mode: 'anonymous-srank', status: 'running', running: true,
        dataCenters: [...(cfg.watch.dataCenters || [])], rank: 's',
        totalTargets: tasks.length, completed: 0, recordsFound: 0, noRecord: 0,
        errors: 0, startedAt: new Date(started).toISOString(), finishedAt: null,
        durationMs: 0, lastError: null, resourcesReady: true, reason
      });
      log(`[sync] 开始免登录 S 怪扫描：${definitions.length} 只 S × ${worlds.length} 个服务器 = ${tasks.length} 项；并发 ${cfg.watch.sRankConcurrency}，间隔 ${cfg.watch.sRankRequestDelayMs}ms`);

      const oldState = store.loadState();
      const results = [];
      const changedEvents = [];
      let cursor = 0;
      let nextStartAt = 0;
      const concurrency = Math.max(1, Math.min(4, Number(cfg.watch.sRankConcurrency) || 2));
      const requestDelayMs = Math.max(250, Math.min(3000, Number(cfg.watch.sRankRequestDelayMs) || 400));

      async function acquireSlot() {
        const now = Date.now();
        const startAt = Math.max(now, nextStartAt);
        nextStartAt = startAt + requestDelayMs;
        if (startAt > now) await sleep(startAt - now);
      }

      async function worker() {
        while (true) {
          const index = cursor++;
          if (index >= tasks.length) return;
          const task = tasks[index];
          await acquireSlot();
          try {
            const response = await rest.huntInfo(task.name, task.worldName);
            const normalized = normalizeHuntInfo(task.name, task.worldName, response.json, task.definition);
            if (normalized) {
              normalized.huntName = mapToLocalName(normalized.huntName);
              results.push(normalized);
              syncState.recordsFound++;
            } else {
              syncState.noRecord++;
            }
          } catch (error) {
            syncState.errors++;
            if ([401, 403, 429].includes(Number(error.status)) && !syncState.lastError) {
              syncState.lastError = `HTTP ${error.status}：${error.message}`;
            } else if (!syncState.lastError) {
              syncState.lastError = error.message;
            }
          } finally {
            syncState.completed++;
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      // Keep the newest known death timestamp; do not let older history responses roll back state.
      for (const row of results) {
        const key = keyOf(row.worldName, row.huntName);
        const previous = oldState.hunts?.[key];
        const previousTs = Number(previous?.lastDeathTime) || 0;
        if (Number(row.lastDeathTime) > previousTs) {
          changedEvents.push({
            source: 'anonymous-huntInfo', event: 'huntInfo', type: 'death', rank: 's',
            huntName: row.huntName, worldName: row.worldName,
            time: row.lastDeathTime, lastDeathTime: row.lastDeathTime,
            at: row.lastDeathAt, region: row.region, patch: row.patch,
            count: row.count, receivedAt: new Date().toISOString()
          });
        }
      }
      store.applyTimers(results, keyOf);
      for (const event of changedEvents) {
        store.appendEvent(event);
      }

      const ended = Date.now();
      Object.assign(syncState, {
        status: syncState.errors && !syncState.recordsFound ? 'error' : 'completed',
        running: false,
        finishedAt: new Date(ended).toISOString(),
        lastSyncAt: new Date(ended).toISOString(),
        durationMs: ended - started,
        lastError: syncState.lastError
      });
      log(`[sync] 免登录 S 怪同步完成：记录 ${results.length} 条；空记录 ${syncState.noRecord} 项；错误 ${syncState.errors} 项；耗时 ${(syncState.durationMs / 1000).toFixed(1)} 秒`);
      return { ...syncState, records: results.length };
    })().catch(error => {
      syncState.status = 'error';
      syncState.running = false;
      syncState.lastError = error.message;
      syncState.finishedAt = new Date().toISOString();
      syncState.lastSyncAt = syncState.finishedAt;
      log(`[sync] 免登录 S 怪同步失败：${error.message}`);
      throw error;
    }).finally(() => { syncPromise = null; });
    return syncPromise;
  }

  async function updateAliases(aliases) {
    const db = resources?.DatabaseHunt || {};
    const next = {};
    const used = new Set();
    for (const [localRaw, remoteRaw] of Object.entries(aliases || {})) {
      const localName = String(localRaw || '').trim();
      const trackerName = String(remoteRaw || '').trim();
      if (!localName || !trackerName) continue;
      if (!db[trackerName]) throw Object.assign(new Error(`Bear Tracker 词库中不存在：${trackerName}`), { status: 400 });
      if (Number(db[trackerName].Rank) !== 5) throw Object.assign(new Error(`${trackerName} 不是 Rank=5 的 S 怪，不能绑定。`), { status: 400 });
      if (used.has(trackerName)) throw Object.assign(new Error(`同一个 Bear S 怪不能重复绑定：${trackerName}`), { status: 400 });
      used.add(trackerName);
      next[localName] = trackerName;
    }
    cfg.aliases = next;
    config.save(cfg);
    return { count: Object.keys(next).length };
  }

  async function updateDataCenters(dataCenters) {
    const available = new Set(Object.keys(resources?.DataCenters || {}));
    const next = [...new Set((dataCenters || []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!next.length) throw Object.assign(new Error('至少选择一个数据中心。'), { status: 400 });
    const invalid = next.filter(value => !available.has(value));
    if (invalid.length) throw Object.assign(new Error(`未知数据中心：${invalid.join('、')}`), { status: 400 });
    cfg.watch.dataCenters = next;
    cfg.watch.worlds = [];
    config.save(cfg);
    setImmediate(() => runAnonymousSRankSync('data-center-change').catch(() => {}));
    return { dataCenters: next };
  }

  const localServer = new LocalServer({
    cfg, rest, store, socket: null, log,
    updateAliases, updateDataCenters,
    getStatus: () => ({
      mode: 'anonymous-srank', authenticated: false, username: null,
      socketConnected: false, timerCount: Object.values(store.loadState().hunts || {}).filter(row => row.rank === 's').length,
      aliasCount: Object.keys(cfg.aliases || {}).length,
      sRankDefinitionCount: sRankDefinitions().length,
      dataCenters: cfg.watch.dataCenters || [],
      sync: { ...syncState },
      resourcesReady: remoteReady
    })
  }).start();

  localServer.on('manualSync', () => {
    runAnonymousSRankSync('manual').catch(() => {});
  });

  // Start the localhost server first. Network initialization and the full scan are background tasks.
  (async () => {
    try {
      await ensureResources();
      await runAnonymousSRankSync('startup');
    } catch (error) {
      syncState.status = 'error';
      syncState.running = false;
      syncState.lastError = error.message;
      log(`[init] Bear Tracker 匿名初始化失败：${error.message}；本地接口仍保持运行，可稍后点击“立即同步”。`);
    }
  })();

  const refreshSec = Math.max(600, Number(cfg.watch.sRankRefreshSec || cfg.watch.timersRefreshSec) || 900);
  const refreshTimer = setInterval(() => {
    if (remoteReady) runAnonymousSRankSync('scheduled').catch(() => {});
  }, refreshSec * 1000);

  const shutdown = () => {
    log('[exit] 正在关闭本地 S 怪同步桥接');
    clearInterval(refreshTimer);
    localServer.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  log(`[ready] 免登录 S 怪桥接服务：http://${cfg.local.host}:${cfg.local.port}；数据中心=${(cfg.watch.dataCenters || []).join('、')}`);
}

async function main() {
  const mode = process.argv[2] || 'serve';
  if (mode === 'serve') return runServe();
  if (mode === 'sync') {
    const rest = new TrackerRest(cfg, log);
    const store = new Store(cfg);
    await rest.bootstrap();
    const resources = await getResources(rest, store);
    const worlds = worldsFor(resources);
    const targets = Object.entries(resources.DatabaseHunt).filter(([, row]) => Number(row?.Rank) === 5);
    console.log(JSON.stringify({ mode: 'anonymous-srank', sRankCount: targets.length, worlds, instruction: '启动服务请运行 node src/index.js' }, null, 2));
    return;
  }
  console.log('仅支持：node src/index.js（启动）或 node src/index.js sync（检查匿名资源）。');
}

main().catch(error => { console.error(`[FATAL] ${error.message}`); process.exitCode = 1; });
