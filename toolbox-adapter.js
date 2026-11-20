/* FF14 Srank <-> Bear Tracker anonymous S-rank adapter.
 * This build is read-only against Bear Tracker and does not require an account.
 * It imports Rank=5 S-rank kill anchors only; no A/B/FATE data and no upstream writes.
 */
(function FF14BearAnonymousSRankAdapter(){
  'use strict';
  if (window.__FF14BearAnonymousAdapterInstalled) return;
  window.__FF14BearAnonymousAdapterInstalled = true;

  const CONFIG = Object.assign({
    baseUrl: 'http://127.0.0.1:8787',
    requestTimeoutMs: 2200,
    maxHistoryScan: 5000,
    pullChunkSize: 8,
    syncPollMs: 1800
  }, window.FF14BearBridgeConfig || {});
  const STORAGE = 'ff14_bear_anonymous_srank_state_v3';
  const state = {
    serviceReady: false,
    syncStatus: 'offline',
    syncRunning: false,
    totalTargets: 0,
    completed: 0,
    timerCount: 0,
    sRankCount: 0,
    aliasCount: 0,
    pulled: 0,
    skipped: 0,
    lastSyncAt: null,
    lastAppliedSyncAt: null,
    lastError: null
  };

  let panel = null;
  let pill = null;
  let panelDetail = null;
  let dcSelect = null;
  let mapList = null;
  let mapSearch = null;
  let localMonsterList = [];
  let cachedRemoteHunts = [];
  let cachedAliases = {};
  let mappingLoaded = false;
  let syncWaitToken = 0;
  let statusTimer = null;
  let healthBusy = false;
  let pullBusy = false;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const url = path => CONFIG.baseUrl.replace(/\/$/, '') + path;
  const log = (...args) => console.info('[FF14 Bear S Sync]', ...args);
  const warn = (...args) => console.warn('[FF14 Bear S Sync]', ...args);
  const toSeconds = value => {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  };
  const localDate = sec => {
    const date = new Date(sec * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  function persistState(){
    try {
      localStorage.setItem(STORAGE, JSON.stringify({
        pulled: state.pulled, skipped: state.skipped,
        lastSyncAt: state.lastSyncAt, lastAppliedSyncAt: state.lastAppliedSyncAt
      }));
    } catch {}
  }
  function restoreState(){
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE) || '{}');
      state.pulled = Number(value.pulled) || 0;
      state.skipped = Number(value.skipped) || 0;
      state.lastSyncAt = value.lastSyncAt || null;
      state.lastAppliedSyncAt = value.lastAppliedSyncAt || null;
    } catch {}
  }
  async function request(path, options = {}){
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('本机桥接请求超时')), CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(url(path), Object.assign({
        cache: 'no-store', signal: controller.signal
      }, options));
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { raw: text.slice(0, 240) }; }
      if (!response.ok) {
        const error = new Error(data.error || `${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  function readRecords(){
    try {
      const data = JSON.parse(localStorage.getItem('ff14_all_kill_records') || '[]');
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }
  function buildLatestIndex(records){
    const index = new Map();
    for (const item of records.slice(0, CONFIG.maxHistoryScan)) {
      if (!item?.server || !item?.name) continue;
      let ms = Number(item.killTimeMs || item.killTsMs || (Number(item.killTs) > 0 ? Number(item.killTs) * 1000 : 0));
      if (!Number.isFinite(ms) || ms <= 0) ms = item.time ? (Date.parse(String(item.time).replace(/-/g, '/')) || 0) : 0;
      const key = `${item.server}|${item.name}`;
      if (ms > (index.get(key) || 0)) index.set(key, ms);
    }
    return index;
  }
  function isKnownLocalSName(name){
    if (!name || !localMonsterList.length) return false;
    return localMonsterList.some(monster => monster.name === name);
  }

  function applyRecord(record, latestIndex, addedRecords){
    const server = String(record?.worldName || record?.server || '').trim();
    const name = String(record?.huntName || record?.sName || record?.name || '').trim();
    const killTs = toSeconds(record?.lastDeathTime ?? record?.killTs ?? record?.time ?? record?.lastDeathAt);
    if (!server || !name || !killTs || (record.rank !== 's' && Number(record.rankCode) !== 5)) {
      state.skipped++;
      return false;
    }
    if (!isKnownLocalSName(name)) {
      state.skipped++;
      return false;
    }
    const killMs = killTs * 1000;
    const key = `${server}|${name}`;
    if ((latestIndex.get(key) || 0) >= killMs) {
      state.skipped++;
      return false;
    }
    if (typeof window.addAllKillRecord !== 'function') return false;

    const row = window.addAllKillRecord(server, name, record.region || record.area || '', 'Bear Tracker 免登录 S 同步', {
      triggerTimeMs: killMs, killTimeMs: killMs, syncSource: 'bear-tracker-anonymous'
    });
    if (!row || typeof row !== 'object') return false;
    row.killTimeMs = killMs;
    row.killTs = killTs;
    row.triggerTimeMs = killMs;
    row.time = localDate(killTs);
    row.syncSource = 'bear-tracker-anonymous';
    latestIndex.set(key, killMs);
    addedRecords.push(row);
    state.pulled++;
    return true;
  }

  function persistAddedBatch(addedRecords){
    if (!addedRecords.length) return;
    const current = readRecords();
    // addAllKillRecord unshifts each record, so reverse the collected batch for newest-first order.
    const merged = [...addedRecords.slice().reverse(), ...current];
    const max = Math.max(1000, Number(window.PredictorConfig?.MAX_RECORDS) || 5000);
    try { localStorage.setItem('ff14_all_kill_records', JSON.stringify(merged.slice(0, max))); }
    catch (error) { warn('保存同步记录失败：', error.message); }
  }

  async function pullSnapshot(syncAt){
    if (pullBusy) return { added: 0, busy: true };
    pullBusy = true;
    try {
      const data = await request('/hunts?rank=s');
      const rows = Array.isArray(data.hunts) ? data.hunts : [];
      const existing = readRecords();
      const latestIndex = buildLatestIndex(existing);
      let added = 0;
      for (let offset = 0; offset < rows.length; offset += CONFIG.pullChunkSize) {
        const chunk = rows.slice(offset, offset + CONFIG.pullChunkSize);
        const batch = [];
        const previousBulk = window.__ff14MonitorBulkSyncActive;
        const originalDirtyMarker = window.__ff14MonitorMarkKillRecordsDirty;
        const predictor = window.__predictor;
        const originalInvalidate = predictor && predictor.invalidate;
        try {
          // Keep the bulk flag only during this synchronous chunk; never leave it set across a yield.
          window.__ff14MonitorBulkSyncActive = true;
          if (typeof originalDirtyMarker === 'function') window.__ff14MonitorMarkKillRecordsDirty = () => {};
          if (predictor && typeof originalInvalidate === 'function') predictor.invalidate = () => {};
          for (const row of chunk) if (applyRecord(row, latestIndex, batch)) added++;
        } finally {
          window.__ff14MonitorBulkSyncActive = previousBulk;
          if (typeof originalDirtyMarker === 'function') window.__ff14MonitorMarkKillRecordsDirty = originalDirtyMarker;
          if (predictor && typeof originalInvalidate === 'function') predictor.invalidate = originalInvalidate;
        }
        // Persist once per small batch, then yield so input/render work can proceed.
        if (batch.length) persistAddedBatch(batch);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (added) refreshUI();
      if (syncAt) state.lastAppliedSyncAt = syncAt;
      persistState();
      updatePanelStatus();
      log(`S 怪 CD 快照应用完成：新增 ${added} 条，已存在/跳过 ${rows.length - added} 条`);
      return { added, count: rows.length };
    } finally { pullBusy = false; }
  }

  function refreshUI(){
    // Exactly one refresh pass after an imported batch, not once per monster.
    try { window.renderRecentList?.(); } catch {}
    try { window.renderAllKillRecordsList?.(); } catch {}
    try { window.calcManual?.(); } catch {}
    try { window.__predictor?.invalidate?.(); } catch {}
  }

  function updatePill(){
    if (!pill) return;
    let text = 'Bear S 怪 CD：';
    if (!state.serviceReady) text += '本机服务未连接';
    else if (state.syncRunning) text += `后台同步 ${state.completed}/${state.totalTargets}`;
    else if (state.syncStatus === 'error') text += '同步异常';
    else text += `${state.timerCount} 条已缓存`;
    pill.textContent = text;
    pill.dataset.state = !state.serviceReady ? 'off' : state.syncRunning ? 'pending' : state.syncStatus === 'error' ? 'warn' : 'on';
  }
  function updatePanelStatus(){
    const target = panel?.querySelector('[data-role="connection"]');
    if (!target) { updatePill(); return; }
    if (!state.serviceReady) {
      target.textContent = `本机桥接服务未连接。\n请先运行桥接文件夹中的“启动.cmd”。\n页面不会等待远端请求，也不会因此卡住。`;
    } else {
      const progress = state.syncRunning ? `正在扫描 ${state.completed}/${state.totalTargets} 个 S 怪/服务器组合` : `最近一次扫描：${state.lastSyncAt || '尚未完成'}`;
      target.textContent = `模式：免登录 · 仅 S 怪（Rank=5）\n本机服务：已连接\n数据中心：${(state.dataCenters || []).join('、') || '未选择'}\nS 怪词库：${state.sRankCount} 只 · 已缓存击杀锚点：${state.timerCount} 条\n${progress}\n已导入：${state.pulled} 条 · 重复/无效跳过：${state.skipped} 条${state.lastError ? `\n最近提示：${state.lastError}` : ''}`;
    }
    const mapping = panel?.querySelector('[data-role="mapping-count"]');
    if (mapping) mapping.textContent = `Bear Tracker Rank=5：${state.sRankCount} 只；工具箱正式 S 怪：${localMonsterList.length} 只；已绑定：${Object.keys(cachedAliases).length} 条。`;
    const syncButton = panel?.querySelector('[data-action="sync"]');
    if (syncButton) { syncButton.disabled = !state.serviceReady || state.syncRunning; syncButton.textContent = state.syncRunning ? `扫描中 ${state.completed}/${state.totalTargets}` : '立即同步 S 怪 CD'; }
    updatePill();
  }

  function applyHealth(health){
    state.serviceReady = !!health?.ok;
    state.syncRunning = !!health?.sync?.running;
    state.syncStatus = health?.sync?.status || (state.serviceReady ? 'ready' : 'offline');
    state.totalTargets = Number(health?.sync?.totalTargets) || 0;
    state.completed = Number(health?.sync?.completed) || 0;
    state.timerCount = Number(health?.timerCount) || 0;
    state.sRankCount = Number(health?.sRankDefinitionCount) || 0;
    state.aliasCount = Number(health?.aliasCount) || 0;
    state.dataCenters = health?.dataCenters || health?.sync?.dataCenters || [];
    state.lastSyncAt = health?.sync?.lastSyncAt || null;
    state.lastError = health?.sync?.lastError || null;
    state.resourcesReady = !!health?.resourcesReady;
    updatePanelStatus();
  }

  async function refreshHealth({ applySnapshot = true } = {}){
    if (healthBusy) return null;
    healthBusy = true;
    try {
      const health = await request('/health');
      applyHealth(health);
      if (applySnapshot && state.serviceReady && !state.syncRunning && state.lastSyncAt && state.lastSyncAt !== state.lastAppliedSyncAt) {
        await pullSnapshot(state.lastSyncAt);
      }
      return health;
    } catch (error) {
      state.serviceReady = false;
      state.syncStatus = 'offline';
      state.lastError = error.message;
      updatePanelStatus();
      return null;
    } finally { healthBusy = false; }
  }

  function getLocalMonsters(){
    const source = window.FF14_OCR_DICTIONARY?.monsters;
    if (!Array.isArray(source)) return [];
    return source.map(monster => ({
      name: monster.name, area: monster.area || '', version: monster.version || '',
      aliases: monster.alias || monster.aliases || []
    })).filter(monster => monster.name);
  }

  async function loadMappingData(){
    if (mappingLoaded) return;
    try {
      const health = await request('/health');
      if (!health.resourcesReady) { setMessage('正在匿名加载 Bear Tracker S 怪词库，请稍后再打开映射设置。', 'info'); return; }
      const [resources, settings] = await Promise.all([request('/resources'), request('/settings')]);
      const db = resources.DatabaseHunt || {};
      cachedRemoteHunts = Object.entries(db)
        .filter(([, definition]) => Number(definition?.Rank) === 5)
        .map(([name, definition]) => ({ name, region: definition.Region || '', patch: definition.Patch || '' }))
        .sort((a,b) => a.name.localeCompare(b.name));
      cachedAliases = settings.aliases || {};
      state.dataCenters = settings.dataCenters || state.dataCenters || [];
      localMonsterList = getLocalMonsters();
      if (dcSelect) {
        dcSelect.replaceChildren();
        for (const name of Object.keys(resources.DataCenters || {})) {
          const option = document.createElement('option');
          option.value = name; option.textContent = name;
          option.selected = state.dataCenters.includes(name);
          dcSelect.appendChild(option);
        }
      }
      renderMappings();
      mappingLoaded = true;
      updatePanelStatus();
    } catch (error) {
      setMessage(`读取 S 怪词库失败：${error.message}`, 'error');
    }
  }

  function renderMappings(){
    if (!mapList) return;
    mapList.replaceChildren();
    const query = String(mapSearch?.value || '').trim().toLocaleLowerCase();
    const filtered = localMonsterList.filter(monster => !query || `${monster.name} ${monster.area} ${monster.version}`.toLocaleLowerCase().includes(query));
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'ff14-bear-empty';
      empty.textContent = '没有找到工具箱正式 S 怪词条。'; mapList.appendChild(empty); return;
    }
    const fragment = document.createDocumentFragment();
    for (const monster of filtered) {
      const row = document.createElement('div'); row.className = 'ff14-bear-map-row';
      const label = document.createElement('label'); label.className = 'ff14-bear-map-label';
      const name = document.createElement('strong'); name.textContent = monster.name;
      const meta = document.createElement('small'); meta.textContent = `${monster.area || '地区未知'} · ${monster.version || '版本未知'}`;
      label.append(name, meta);
      const select = document.createElement('select'); select.dataset.localName = monster.name;
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = '选择 Bear Tracker S 怪'; select.appendChild(blank);
      for (const remote of cachedRemoteHunts) {
        const option = document.createElement('option'); option.value = remote.name;
        option.textContent = `${remote.name} · ${remote.region || '地区未知'}`; select.appendChild(option);
      }
      let chosen = cachedAliases[monster.name] || '';
      if (!chosen) {
        const aliases = [monster.name, ...monster.aliases];
        const exact = cachedRemoteHunts.find(remote => aliases.some(alias => String(alias).toLowerCase() === remote.name.toLowerCase()));
        if (exact) chosen = exact.name;
      }
      if (chosen) select.value = chosen;
      row.append(label, select); fragment.appendChild(row);
    }
    mapList.appendChild(fragment);
  }

  async function saveMappings(){
    const aliases = {};
    const visibleNames = new Set();
    for (const select of mapList?.querySelectorAll('select[data-local-name]') || []) {
      visibleNames.add(select.dataset.localName);
      if (select.value) aliases[select.dataset.localName] = select.value;
    }
    for (const [name, value] of Object.entries(cachedAliases)) if (!visibleNames.has(name)) aliases[name] = value;
    const result = await request('/settings/aliases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aliases })
    });
    cachedAliases = aliases; state.aliasCount = Number(result.count) || Object.keys(aliases).length;
    setMessage(`S 怪名称映射已保存：${state.aliasCount} 条。现在启动一次后台同步。`, 'success');
    await startManualSync();
  }

  async function saveDataCenters(){
    const selected = Array.from(dcSelect?.selectedOptions || []).map(option => option.value);
    const result = await request('/settings/data-centers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataCenters: selected })
    });
    state.dataCenters = result.dataCenters || selected;
    setMessage(`数据中心已保存：${state.dataCenters.join('、')}。后台扫描已启动。`, 'success');
    await waitForSync();
  }

  async function waitForSync(){
    const token = ++syncWaitToken;
    const deadline = Date.now() + 180000;
    while (token === syncWaitToken && Date.now() < deadline) {
      await delay(CONFIG.syncPollMs);
      const health = await refreshHealth({ applySnapshot: false });
      if (!health) return;
      if (!health.resourcesReady && health.sync?.status !== 'error') {
        setMessage('正在初始化 Bear Tracker 公开词库…', 'info');
        continue;
      }
      if (!health.sync?.running && ['completed', 'error'].includes(String(health.sync?.status))) {
        await refreshHealth({ applySnapshot: true });
        const sync = health.sync || {};
        setMessage(sync.status === 'error' ? `S 怪同步未完成：${sync.lastError || '请检查本机服务日志。'}` : `S 怪同步完成：读取 ${sync.completed || 0}/${sync.totalTargets || 0} 项，找到 ${sync.recordsFound || 0} 条击杀记录，空记录 ${sync.noRecord || 0} 项，错误 ${sync.errors || 0} 项。`, sync.status === 'error' || sync.errors ? 'warn' : 'success');
        return;
      }
      const sync = health.sync;
      setMessage(`正在后台查询 S 怪 CD：${sync.completed || 0}/${sync.totalTargets || 0}。页面仍可正常操作。`, 'info');
    }
    if (token === syncWaitToken) setMessage('同步仍在后台执行；可以先关闭面板，完成后再次打开会自动导入结果。', 'warn');
  }

  async function startManualSync(){
    if (state.syncRunning) { setMessage('S 怪同步已经在后台执行。', 'info'); return; }
    try {
      await request('/sync/now', { method: 'POST' });
      setMessage('已启动免登录 S 怪 CD 扫描。查询在本机后台进行，不会阻塞工具箱。', 'success');
      await waitForSync();
    } catch (error) { setMessage(`启动同步失败：${error.message}`, 'error'); }
  }

  function setMessage(message, kind = 'info'){
    const node = panel?.querySelector('[data-role="message"]');
    if (node) { node.textContent = message; node.dataset.kind = kind; }
  }

  function createPanel(){
    if (!document.body || document.getElementById('ff14BearBridgeStatus')) return;
    const style = document.createElement('style'); style.id = 'ff14-bear-bridge-ui-style-v337';
    style.textContent = `
      #ff14BearBridgeStatus{position:fixed;right:16px;bottom:16px;z-index:60120;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef4ff}
      #ff14BearBridgeStatus [hidden]{display:none!important}
      #ff14BearBridgeStatus .ff14-bear-pill{border:1px solid rgba(120,150,190,.45);border-radius:999px;padding:8px 13px;background:rgba(17,27,43,.94);color:#eaf1fb;box-shadow:0 5px 20px #0004;cursor:pointer;backdrop-filter:blur(12px);font-weight:650}
      #ff14BearBridgeStatus .ff14-bear-pill[data-state="on"]{border-color:#36b37e}#ff14BearBridgeStatus .ff14-bear-pill[data-state="pending"]{border-color:#e3a33b}#ff14BearBridgeStatus .ff14-bear-pill[data-state="off"]{border-color:#dc6464}#ff14BearBridgeStatus .ff14-bear-pill[data-state="warn"]{border-color:#e3a33b}
      #ff14BearBridgeStatus .ff14-bear-panel{position:absolute;right:0;bottom:46px;width:min(440px,calc(100vw - 24px));max-height:min(78vh,720px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(148,163,184,.55);border-radius:18px;background:rgba(14,23,38,.97);box-shadow:0 18px 60px #0008;backdrop-filter:blur(20px)}
      #ff14BearBridgeStatus .ff14-bear-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid #ffffff1c;font-size:15px;font-weight:750}
      #ff14BearBridgeStatus .ff14-bear-head button{border:0;background:transparent;color:#d7e3f5;font-size:20px;cursor:pointer}
      #ff14BearBridgeStatus .ff14-bear-body{padding:12px 14px 15px;overflow:auto;overscroll-behavior:contain}
      #ff14BearBridgeStatus .ff14-bear-note{margin:0 0 10px;color:#b8c8dc;font-size:12px}
      #ff14BearBridgeStatus .ff14-bear-status{white-space:pre-line;border:1px solid #ffffff20;background:#ffffff09;border-radius:10px;padding:9px 11px;color:#dce8f7;font-size:12px;margin-bottom:10px}
      #ff14BearBridgeStatus input,#ff14BearBridgeStatus select{box-sizing:border-box;width:100%;min-width:0;border:1px solid #64748b80;border-radius:9px;background:#111d30;color:#f1f5fb;padding:8px;font:inherit}
      #ff14BearBridgeStatus input::placeholder{color:#95a5bb}
      #ff14BearBridgeStatus button.ff14-bear-action{border:1px solid #71839b80;border-radius:9px;background:#26364c;color:#f1f5fb;padding:8px 11px;cursor:pointer;font:inherit;font-weight:650}
      #ff14BearBridgeStatus button.ff14-bear-primary{background:#176b53;border-color:#3eae88}#ff14BearBridgeStatus button:disabled{opacity:.45;cursor:not-allowed}
      #ff14BearBridgeStatus .ff14-bear-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}
      #ff14BearBridgeStatus .ff14-bear-message{margin:10px 0;color:#b7c8dd;font-size:12px;white-space:pre-wrap}#ff14BearBridgeStatus .ff14-bear-message[data-kind="error"]{color:#ff9b9b}#ff14BearBridgeStatus .ff14-bear-message[data-kind="success"]{color:#76ddb4}#ff14BearBridgeStatus .ff14-bear-message[data-kind="warn"]{color:#ffd27b}
      #ff14BearBridgeStatus .ff14-bear-section{margin-top:13px;padding-top:12px;border-top:1px solid #ffffff1c}
      #ff14BearBridgeStatus .ff14-bear-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:700}
      #ff14BearBridgeStatus .ff14-bear-muted{color:#9fb0c7;font-size:11px;font-weight:400}
      #ff14BearBridgeStatus .ff14-bear-map-list{display:flex;flex-direction:column;gap:6px;max-height:230px;overflow:auto;margin-top:8px;padding-right:3px}
      #ff14BearBridgeStatus .ff14-bear-map-row{display:grid;grid-template-columns:minmax(110px,.8fr) minmax(150px,1.2fr);align-items:center;gap:8px;padding:6px 8px;border:1px solid #ffffff17;border-radius:9px;background:#ffffff07}
      #ff14BearBridgeStatus .ff14-bear-map-label{display:flex;flex-direction:column;gap:2px;min-width:0}#ff14BearBridgeStatus .ff14-bear-map-label strong{font-size:12px;overflow-wrap:anywhere}#ff14BearBridgeStatus .ff14-bear-map-label small{font-size:10px;color:#a9bad0}
      #ff14BearBridgeStatus .ff14-bear-empty{color:#a9bad0;font-size:12px}#ff14BearBridgeStatus .ff14-bear-map-list select{font-size:11px;padding:7px}
      #ff14BearBridgeStatus .ff14-bear-dc-select{min-height:78px}
      @media(max-width:520px){#ff14BearBridgeStatus .ff14-bear-map-row{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
    panel = document.createElement('div'); panel.id = 'ff14BearBridgeStatus';
    panel.innerHTML = `
      <button class="ff14-bear-pill" type="button" data-state="off">Bear S 怪 CD：检测本机服务</button>
      <section class="ff14-bear-panel" hidden aria-label="Bear Tracker 免登录 S 怪 CD 同步设置">
        <header class="ff14-bear-head"><span>Bear Tracker · 免登录 S 怪 CD 同步</span><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="ff14-bear-body">
          <p class="ff14-bear-note">只读取 Bear Tracker 匿名可访问的 S 怪历史击杀时间（Rank=5），不需要账号、不读取 A 怪、不上传工具箱数据。扫描在本机 Node 服务后台限速执行。</p>
          <div class="ff14-bear-status" data-role="connection">正在检查本机桥接服务…</div>
          <div class="ff14-bear-actions"><button type="button" class="ff14-bear-action ff14-bear-primary" data-action="sync">立即同步 S 怪 CD</button></div>
          <p class="ff14-bear-message" data-role="message">首次使用：选择数据中心，核对中文 S 怪与 Bear Tracker 英文名称映射，然后同步。</p>
          <section class="ff14-bear-section">
            <div class="ff14-bear-section-title"><span>订阅数据中心</span><span class="ff14-bear-muted">可多选</span></div>
            <select class="ff14-bear-dc-select" data-role="dcs" multiple aria-label="选择要同步的数据中心"></select>
            <div class="ff14-bear-actions"><button type="button" class="ff14-bear-action" data-action="save-dcs">保存数据中心</button></div>
          </section>
          <section class="ff14-bear-section">
            <div class="ff14-bear-section-title"><span>中文 S 怪名称映射</span><span class="ff14-bear-muted">首次核对一次</span></div>
            <p class="ff14-bear-note" data-role="mapping-count">等待读取 Rank=5 S 怪词库。</p>
            <input type="search" data-role="map-search" placeholder="搜索中文 S 怪名称 / 地区">
            <div class="ff14-bear-map-list" data-role="map-list"><p class="ff14-bear-empty">打开面板后载入 S 怪映射。</p></div>
            <div class="ff14-bear-actions"><button type="button" class="ff14-bear-action ff14-bear-primary" data-action="save-maps">保存 S 怪名称映射</button></div>
          </section>
          <p class="ff14-bear-note" style="margin-top:12px">同步方向：Bear Tracker → 工具箱。匿名权限不支持向 Bear Tracker 提交击杀，因此本模式不做反向上报。原有 CD、天气前置和校准数据不会被覆盖。</p>
        </div>
      </section>`;
    document.body.appendChild(panel);
    pill = panel.querySelector('.ff14-bear-pill');
    panelDetail = panel.querySelector('.ff14-bear-panel');
    dcSelect = panel.querySelector('[data-role="dcs"]');
    mapList = panel.querySelector('[data-role="map-list"]');
    mapSearch = panel.querySelector('[data-role="map-search"]');

    pill.addEventListener('click', async () => {
      panelDetail.hidden = !panelDetail.hidden;
      if (!panelDetail.hidden) {
        await refreshHealth();
        await loadMappingData();
        startStatusTimer();
      } else stopStatusTimer();
    });
    panel.querySelector('[data-action="close"]').addEventListener('click', () => { panelDetail.hidden = true; stopStatusTimer(); });
    panel.querySelector('[data-action="sync"]').addEventListener('click', startManualSync);
    panel.querySelector('[data-action="save-dcs"]').addEventListener('click', () => saveDataCenters().catch(error => setMessage(error.message, 'error')));
    panel.querySelector('[data-action="save-maps"]').addEventListener('click', () => saveMappings().catch(error => setMessage(error.message, 'error')));
    mapSearch.addEventListener('input', renderMappings);
    updatePanelStatus();
  }

  function startStatusTimer(){
    stopStatusTimer();
    statusTimer = setInterval(() => {
      if (document.visibilityState === 'hidden' || panelDetail?.hidden) return;
      refreshHealth().then(() => { if (state.resourcesReady && !mappingLoaded && !panelDetail?.hidden) loadMappingData(); }).catch(() => {});
    }, 20000);
  }
  function stopStatusTimer(){ if (statusTimer) clearInterval(statusTimer); statusTimer = null; }

  async function start(){
    restoreState();
    // Load the toolbox's canonical S-rank dictionary before any automatic snapshot import.
    // If the dictionary is unavailable, reject unknown Bear names instead of importing English
    // HuntName values into the Chinese toolbox history.
    localMonsterList = getLocalMonsters();
    await refreshHealth();
    // The Node service starts its remote scan after the local HTTP server is already available.
    // Keep a small async waiter during first initialization so a closed panel still imports the
    // first completed snapshot automatically; no remote request is made from the browser.
    if (state.serviceReady && (state.syncRunning || (!state.resourcesReady && state.syncStatus !== 'error'))) waitForSync();
    // Lightweight health polling catches later 15-minute background refreshes without SSE or
    // per-monster browser work. It never runs while this tab is hidden.
    setInterval(() => {
      if (document.visibilityState === 'hidden' || healthBusy || pullBusy) return;
      refreshHealth().catch(() => {});
    }, 30000);
  }
  window.FF14BearBridge = Object.freeze({
    status: () => ({ ...state }),
    syncNow: startManualSync,
    refresh: refreshHealth,
    pull: pullSnapshot
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { createPanel(); start().catch(error => warn(error.message)); }, { once: true });
  } else {
    createPanel(); start().catch(error => warn(error.message));
  }
})();
