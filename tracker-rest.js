'use strict';
const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function splitSetCookieHeader(value) {
  if (!value) return [];
  // Set-Cookie values may be combined by older fetch implementations. Split only
  // at a comma followed by a new cookie-pair, not the comma in Expires dates.
  return String(value).split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

class TrackerRest {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.cookies = {};
    this.csrfToken = cfg.auth.csrfToken || '';
    this.jarFile = path.join(cfg.dataDir, 'cookies.json');
    this._loadJar();
  }

  _loadJar() {
    try {
      if (fs.existsSync(this.jarFile)) this.cookies = JSON.parse(fs.readFileSync(this.jarFile, 'utf8')) || {};
    } catch { this.cookies = {}; }
    for (const chunk of String(this.cfg.auth.cookie || '').split(';')) {
      const i = chunk.indexOf('=');
      if (i > 0) this.cookies[chunk.slice(0, i).trim()] = chunk.slice(i + 1).trim();
    }
    if (this.cookies.csrftoken && !this.csrfToken) this.csrfToken = this.cookies.csrftoken;
  }

  _saveJar() {
    try {
      fs.writeFileSync(this.jarFile, JSON.stringify(this.cookies, null, 2), { mode: 0o600 });
      try { fs.chmodSync(this.jarFile, 0o600); } catch {}
    } catch (e) { this.log(`[rest] 无法保存本地 Cookie jar：${e.message}`); }
  }

  _captureCookies(res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    else list = splitSetCookieHeader(res.headers.get('set-cookie'));
    let changed = false;
    for (const cookie of list) {
      const pair = String(cookie).split(';', 1)[0];
      const i = pair.indexOf('=');
      if (i > 0) {
        this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        changed = true;
      }
    }
    if (changed) this._saveJar();
  }

  cookieHeader() {
    return Object.entries(this.cookies).filter(([k, v]) => k && v !== undefined)
      .map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async bootstrap() {
    const res = await fetch(this.cfg.tracker.restBase.replace(/\/$/, '') + '/index', {
      headers: { 'User-Agent': UA, Accept: 'text/html', ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}) },
      redirect: 'follow', signal: AbortSignal.timeout(20000)
    });
    this._captureCookies(res);
    const html = await res.text();
    const candidates = [
      /<meta[^>]+name=["']csrfmiddlewaretoken["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrfmiddlewaretoken["']/i,
      /name=["']csrfmiddlewaretoken["'][^>]+value=["']([^"']+)["']/i,
      /value=["']([^"']+)["'][^>]+name=["']csrfmiddlewaretoken["']/i
    ];
    for (const re of candidates) {
      const m = html.match(re);
      if (m) { this.csrfToken = m[1]; break; }
    }
    if (!this.csrfToken && this.cookies.csrftoken) this.csrfToken = this.cookies.csrftoken;
    this._saveJar();
    return { status: res.status, csrf: !!this.csrfToken, hasSession: !!this.cookies.sessionid, cookieNames: Object.keys(this.cookies) };
  }

  async post(endpoint, body = {}, { retryCsrf = true, timeoutMs = 12000 } = {}) {
    if (!this.csrfToken || !this.cookies.sessionid) await this.bootstrap();
    const url = this.cfg.tracker.restBase.replace(/\/$/, '') + endpoint;
    const send = () => fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRFToken': this.csrfToken,
        Accept: 'application/json, text/plain, */*',
        Cookie: this.cookieHeader(),
        Origin: this.cfg.tracker.origin,
        Referer: this.cfg.tracker.origin + '/index'
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs)
    });

    let res = await send();
    this._captureCookies(res);
    if ((res.status === 403 || res.status === 419) && retryCsrf) {
      this.log(`[rest] ${endpoint} 返回 ${res.status}，刷新会话与 CSRF 后重试一次`);
      await this.bootstrap();
      res = await send();
      this._captureCookies(res);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }

  async _ok(endpoint, body) {
    const r = await this.post(endpoint, body);
    if (r.status >= 400) {
      const err = new Error(`${endpoint} 返回 ${r.status}: ${String(r.text).slice(0, 240)}`);
      err.status = r.status; err.body = r.text; throw err;
    }
    return r;
  }


  async login(username, password) {
    const response = await this.post('/api/login', {
      Username: String(username || '').trim(),
      Password: String(password || ''),
      RememberMe: true
    });
    if (response.status >= 400 || !response.json) {
      const error = new Error(`Bear Tracker 登录失败（HTTP ${response.status}）：${String(response.text || '').slice(0, 180)}`);
      error.status = response.status;
      throw error;
    }
    const user = response.json.User || response.json.user || {};
    const apiToken = user.APIToken || user.ApiToken || response.json.APIToken || '';
    if (!apiToken) {
      const error = new Error('登录响应中没有 User.APIToken；无法完成 S/A 怪 Socket 权限订阅。请确认账号登录成功且接口响应结构未变化。');
      error.status = 502;
      throw error;
    }
    this.cfg.auth.apiToken = apiToken;
    return { response: response.json, user, apiToken };
  }

  clearSession() {
    this.cookies = {};
    this.csrfToken = '';
    try { fs.rmSync(this.jarFile, { force: true }); } catch {}
  }

  syncSession() { return this._ok('/api/syncSession', {}); }
  lastDeathTimers(worlds, rankType = 'srank') {
    return this._ok('/api/lastDeathTimers', { QueryDeathTimers: worlds, RankType: rankType });
  }
  async huntInfo(huntName, worldName) {
    const response = await this.post('/api/huntInfo', { HuntName: huntName, WorldName: worldName }, { retryCsrf: true, timeoutMs: 10000 });
    if (response.status >= 400) {
      const error = new Error(`/api/huntInfo 返回 ${response.status}: ${String(response.text || '').slice(0, 160)}`);
      error.status = response.status;
      throw error;
    }
    if (!response.json || typeof response.json !== 'object') throw new Error('/api/huntInfo 返回了无法解析的 JSON。');
    return response;
  }
  getLinkFATEInfo(huntName, worldName) { return this._ok('/api/getLinkFATEInfo', { HuntName: huntName, WorldName: worldName }); }

  reportDeath({ huntName, worldName, reportTime, missing = 0 }) {
    return this._ok('/api/deathReport', {
      HuntName: huntName, WorldName: worldName,
      ReportTime: Math.floor(reportTime || Date.now() / 1000), Missing: missing ? 1 : 0
    });
  }
  reportFound({ huntName, worldName, report = true }) {
    return this._ok('/api/foundReport', { HuntName: huntName, WorldName: worldName, Report: !!report });
  }
  querySpawnPoints({ huntName, worldName, mode = 'Query', mapPoint, version, position, state }) {
    const body = { WorldName: worldName, HuntName: huntName, QuerySpawnPoint: mode };
    if (mode === 'Set') Object.assign(body, { MapPoint: mapPoint, Version: version, Position: position, State: state ? 1 : 0 });
    return this._ok('/api/querySpawnPoints', body);
  }
  setSpawnAttempt(huntName, worldName) {
    return this._ok('/api/querySpawnAttempts', { QueryMethod: 'SetAttempt', HuntName: huntName, WorldName: worldName });
  }
  revertDeathReport({ huntName, worldName, id }) {
    return this._ok('/api/revertDeathReport', { HuntName: huntName, WorldName: worldName, ID: id });
  }
  searchHistory({ worldNames = [], huntNames = [], startTime, endTime }) {
    return this._ok('/api/searchHistory', {
      WorldNames: worldNames, HuntNames: huntNames,
      StartTime: Math.floor(startTime), EndTime: Math.floor(endTime)
    });
  }
  updateSession(patch) { return this.post('/api/updateSession', patch); }
}

module.exports = { TrackerRest, UA };
