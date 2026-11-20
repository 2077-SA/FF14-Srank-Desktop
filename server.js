'use strict';
const http = require('node:http');
const { EventEmitter } = require('node:events');

function safeJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('JSON 格式无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const keyOf = (world, hunt) => `${String(world)}|${String(hunt)}`;
const isTransient = error => !Number.isFinite(Number(error?.status)) || Number(error.status) === 429 || Number(error.status) >= 500;

class LocalServer extends EventEmitter {
  constructor({ cfg, rest, store, socket, log, getStatus = () => ({}), authenticate = null, logout = null, updateAliases = null, updateDataCenters = null }) {
    super();
    Object.assign(this, { cfg, rest, store, socket, log, getStatus, authenticate, logout, updateAliases, updateDataCenters });
    this.sseClients = new Map();
    this.recent = [];
    this.server = null;
    this.drainBusy = false;
  }
  toTrackerName(name) { return this.cfg.aliases?.[name] || name; }
  toLocalName(name) {
    for (const [localName, trackerName] of Object.entries(this.cfg.aliases || {})) if (trackerName === name) return localName;
    return name;
  }
  corsHeaders(req) {
    const origin = req.headers.origin;
    const allow = new Set(this.cfg.local.allowedOrigins || ['null']);
    const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || '');
    const headers = { Vary: 'Origin' };
    if (!origin || allow.has(origin) || loopback) {
      headers['Access-Control-Allow-Origin'] = origin || 'null';
      headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Bridge-Key';
    }
    return headers;
  }
  checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const allow = new Set(this.cfg.local.allowedOrigins || ['null']);
    return allow.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  }
  broadcast(event) {
    this.recent.push(event);
    if (this.recent.length > 500) this.recent.shift();
    const packet = `data: ${JSON.stringify(event)}\n\n`;
    for (const [res] of this.sseClients) { try { res.write(packet); } catch {} }
    this.pushWebhook(event).catch(() => {});
  }
  async pushWebhook(event) {
    const url = this.cfg.local.webhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.local.webhookSecret ? { 'X-Bridge-Secret': this.cfg.local.webhookSecret } : {})
        }, body: JSON.stringify(event), signal: AbortSignal.timeout(this.cfg.local.webhookTimeoutMs || 8000)
      });
    } catch (error) { this.log(`[webhook] 回调失败：${error.message}`); }
  }
  async dispatch(kind, payload) {
    const handlers = {
      death: p => this.rest.reportDeath(p),
      found: p => this.rest.reportFound(p),
      spawnpoint: p => this.rest.querySpawnPoints(p),
      attempt: p => this.rest.setSpawnAttempt(p.huntName, p.worldName),
      revert: p => this.rest.revertDeathReport(p)
    };
    const handler = handlers[kind];
    if (!handler) throw Object.assign(new Error(`未知上报类型：${kind}`), { status: 400 });
    if (!this.cfg.sync.allowUpstreamReports) throw Object.assign(new Error('配置已关闭上行上报'), { status: 403 });
    try {
      const response = await handler(payload);
      return { queued: false, status: response.status, data: response.json || String(response.text || '').slice(0, 200) };
    } catch (error) {
      if (this.cfg.sync.queueTransientFailures && isTransient(error)) {
        const dedupeKey = `${kind}|${payload.worldName}|${payload.huntName}|${payload.reportTime || payload.id || ''}`;
        this.store.enqueue({ kind, payload }, dedupeKey);
        this.log(`[outbox] ${kind} 暂时失败，已进入待重试队列：${error.message}`);
        return { queued: true, error: error.message };
      }
      this.log(`[upstream] ${kind} 未入队（非临时错误）：${error.message}`);
      throw error;
    }
  }
  async sendQueued(item) {
    const p = item.payload;
    switch (item.kind) {
      case 'death': return this.rest.reportDeath(p);
      case 'found': return this.rest.reportFound(p);
      case 'spawnpoint': return this.rest.querySpawnPoints(p);
      case 'attempt': return this.rest.setSpawnAttempt(p.huntName, p.worldName);
      case 'revert': return this.rest.revertDeathReport(p);
      default: throw Object.assign(new Error(`未知队列类型：${item.kind}`), { status: 400 });
    }
  }
  async drainOutbox() {
    if (this.drainBusy) return;
    this.drainBusy = true;
    try {
      const list = this.store.loadOutbox();
      if (!list.length) return;
      for (const item of list) {
        try {
          await this.sendQueued(item);
          this.store.removeFromOutbox(item.id);
          this.log(`[outbox] 已补发 ${item.kind} ${item.payload?.huntName || ''}`);
        } catch (error) {
          this.store.markAttempt(item.id, error.message);
          if (!isTransient(error) || (Number(item.attempts) + 1) >= (this.cfg.sync.maxOutboxAttempts || 8)) {
            this.log(`[outbox] ${item.kind} 停止自动重试：${error.message}`);
            this.store.removeFromOutbox(item.id);
            continue;
          }
          break;
        }
      }
    } finally { this.drainBusy = false; }
  }
  async route(req, res) {
    const cors = this.corsHeaders(req);
    if (!this.checkOrigin(req)) return safeJson(res, 403, { error: '此页面来源不在本地桥接允许列表中', origin: req.headers.origin }, cors);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/auth/status') {
        return safeJson(res, 200, { ok: true, ...this.getStatus(), socketConnected: !!this.socket?.connected, rooms: this.socket?.rooms || [] }, cors);
      }
      if (req.method === 'POST' && pathname === '/auth/login') {
        const body = await readBody(req, 32 * 1024);
        const username = String(body.username || body.Username || '').trim();
        const password = String(body.password || body.Password || '');
        if (!username || !password) return safeJson(res, 400, { error: '请输入 Bear Tracker 用户名和密码。' }, cors);
        if (typeof this.authenticate !== 'function') return safeJson(res, 503, { error: '本地桥接尚未启用登录处理器。' }, cors);
        const result = await this.authenticate({ username, password });
        return safeJson(res, 200, { ok: true, ...result }, cors);
      }
      if (req.method === 'POST' && pathname === '/auth/logout') {
        if (typeof this.logout === 'function') await this.logout();
        return safeJson(res, 200, { ok: true, loggedOut: true }, cors);
      }
      if (req.method === 'GET' && pathname === '/health') {
        const state = this.store.loadState();
        return safeJson(res, 200, {
          ok: true, ...this.getStatus(), socketConnected: !!this.socket?.connected,
          rooms: this.socket?.rooms || [], hunts: Object.keys(state.hunts || {}).length,
          outbox: this.store.loadOutbox().length, sseClients: this.sseClients.size,
          uptimeSec: Math.floor(process.uptime())
        }, cors);
      }
      if (req.method === 'GET' && pathname === '/resources') return safeJson(res, 200, this.store.loadResources() || {}, cors);
      if (req.method === 'GET' && pathname === '/settings') return safeJson(res, 200, { dataCenters: this.cfg.watch.dataCenters || [], aliases: this.cfg.aliases || {} }, cors);
      if (req.method === 'POST' && pathname === '/settings/aliases') {
        const body = await readBody(req, 256 * 1024);
        const aliases = body.aliases;
        if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return safeJson(res, 400, { error: 'aliases 必须是对象。' }, cors);
        if (typeof this.updateAliases !== 'function') return safeJson(res, 503, { error: '映射保存功能尚未就绪。' }, cors);
        const result = await this.updateAliases(aliases);
        return safeJson(res, 200, { ok: true, ...result }, cors);
      }
      if (req.method === 'POST' && pathname === '/settings/data-centers') {
        const body = await readBody(req, 32 * 1024);
        const dataCenters = body.dataCenters;
        if (!Array.isArray(dataCenters) || !dataCenters.length) return safeJson(res, 400, { error: '至少选择一个数据中心。' }, cors);
        if (typeof this.updateDataCenters !== 'function') return safeJson(res, 503, { error: '数据中心设置功能尚未就绪。' }, cors);
        const result = await this.updateDataCenters(dataCenters);
        return safeJson(res, 200, { ok: true, ...result }, cors);
      }
      if (req.method === 'GET' && pathname === '/state') return safeJson(res, 200, this.store.loadState(), cors);
      if (req.method === 'GET' && pathname === '/hunts') {
        const state = this.store.loadState();
        const world = url.searchParams.get('world'); const rank = url.searchParams.get('rank');
        const hunts = Object.values(state.hunts || {}).filter(h => (!world || h.worldName === world) && (!rank || h.rank === rank));
        return safeJson(res, 200, { count: hunts.length, updatedAt: state.updatedAt, hunts }, cors);
      }
      if (req.method === 'GET' && pathname.startsWith('/hunts/')) {
        const parts = pathname.split('/').filter(Boolean);
        const world = decodeURIComponent(parts[1] || ''); const hunt = decodeURIComponent(parts.slice(2).join('/'));
        const item = this.store.loadState().hunts[keyOf(world, hunt)];
        return item ? safeJson(res, 200, item, cors) : safeJson(res, 404, { error: '未缓存该怪物' }, cors);
      }
      if (req.method === 'GET' && pathname === '/events/recent') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)));
        const persisted = this.store.tailEvents(limit);
        return safeJson(res, 200, { events: [...persisted, ...this.recent].slice(-limit) }, cors);
      }
      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString(), ...this.getStatus() })}\n\n`);
        const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 20000);
        this.sseClients.set(res, heartbeat);
        req.on('close', () => { clearInterval(heartbeat); this.sseClients.delete(res); });
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/report/')) {
        const body = await readBody(req);
        const kind = pathname.slice('/report/'.length);
        if (!['death', 'found', 'spawnpoint', 'attempt', 'revert'].includes(kind)) return safeJson(res, 404, { error: `未知上报类型：${kind}` }, cors);
        const huntName = String(body.huntName || body.hunt || '').trim();
        const worldName = String(body.worldName || body.world || '').trim();
        if (!huntName || !worldName) return safeJson(res, 400, { error: '缺少 huntName 或 worldName' }, cors);
        if (!this.getStatus().authenticated) return safeJson(res, 401, { error: '请先在工具箱的 Bear Tracker 设置中登录账号。' }, cors);
        const mappedHunt = this.cfg.aliases?.[huntName];
        const containsHan = /\p{Script=Han}/u.test(huntName);
        if (containsHan && !mappedHunt) return safeJson(res, 400, { error: `怪物名称尚未配置 Bear Tracker 英文映射：${huntName}；请在 config.json 的 aliases 中添加。` }, cors);
        const payload = { ...body, huntName: mappedHunt || huntName, worldName };
        if (kind === 'death') {
          const n = Number(body.reportTime || body.killTs || body.time || Math.floor(Date.now() / 1000));
          payload.reportTime = Math.floor(n > 1e12 ? n / 1000 : n);
          payload.missing = body.missing ? 1 : 0;
        }
        const result = await this.dispatch(kind, payload);
        return safeJson(res, result.queued ? 202 : 200, { ...result, sent: { ...payload, huntName: '***mapped***' } }, cors);
      }
      if (req.method === 'POST' && pathname === '/rooms') {
        const body = await readBody(req);
        const rooms = body.dataCenters || body.rooms || [];
        if (!Array.isArray(rooms) || !rooms.length) return safeJson(res, 400, { error: 'dataCenters 需要非空数组' }, cors);
        this.socket.setRooms(rooms);
        return safeJson(res, 200, { rooms: this.socket.rooms }, cors);
      }
      if (req.method === 'GET' && pathname === '/rooms') return safeJson(res, 200, { rooms: this.socket?.rooms || [] }, cors);
      if (req.method === 'POST' && pathname === '/sync/now') {
        this.emit('manualSync');
        return safeJson(res, 202, { accepted: true }, cors);
      }
      return safeJson(res, 404, { error: `未知路径 ${pathname}` }, cors);
    } catch (error) {
      this.log(`[http] ${pathname} 出错：${error.message}`);
      return safeJson(res, Number(error.status) || 500, { error: error.message }, cors);
    }
  }
  start() {
    this.server = http.createServer((req, res) => this.route(req, res));
    const { host = '127.0.0.1', port = 8787 } = this.cfg.local;
    this.server.listen(port, host, () => this.log(`[http] 本地接口已启动 http://${host}:${port}`));
    if (this.cfg.sync?.allowUpstreamReports) {
      this.timer = setInterval(() => this.drainOutbox().catch(error => this.log(`[outbox] ${error.message}`)), 5000);
    }
    return this;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const [res, heartbeat] of this.sseClients) { clearInterval(heartbeat); try { res.end(); } catch {} }
    this.sseClients.clear();
    if (this.server) this.server.close();
  }
}

module.exports = { LocalServer, keyOf, isTransient };
