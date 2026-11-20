'use strict';
const fs = require('node:fs');
const path = require('node:path');

function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

class Store {
  constructor(cfg) {
    this.dir = cfg.dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.files = {
      resources: path.join(this.dir, 'resources.json'),
      state: path.join(this.dir, 'state.json'),
      outbox: path.join(this.dir, 'outbox.json'),
      events: path.join(this.dir, 'events.jsonl'),
      seen: path.join(this.dir, 'seen-events.json')
    };
  }
  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  loadResources() { return this._readJson(this.files.resources, null); }
  saveResources(resources) {
    atomicWrite(this.files.resources, {
      fetchedAt: new Date().toISOString(),
      DatabaseHunt: resources?.DatabaseHunt || {},
      DatabaseFate: resources?.DatabaseFate || {},
      DataCenters: resources?.DataCenters || {},
      Instances: resources?.Instances || {},
      Regions: resources?.Regions || {},
      SpawnPoint: resources?.SpawnPoint || {}
    });
  }
  loadState() { return this._readJson(this.files.state, { updatedAt: null, hunts: {} }); }
  saveState(state) { state.updatedAt = new Date().toISOString(); atomicWrite(this.files.state, state); }
  applyTimers(timers, keyOf) {
    const state = this.loadState();
    for (const timer of timers) {
      if (!timer?.worldName || !timer?.huntName) continue;
      const key = keyOf(timer.worldName, timer.huntName);
      const current = state.hunts[key];
      const newTs = Number(timer.lastDeathTime) || 0;
      const oldTs = Number(current?.lastDeathTime) || 0;
      if (!current || newTs >= oldTs || !oldTs) state.hunts[key] = { ...(current || {}), ...timer };
      else state.hunts[key] = { ...timer, ...current, refreshedAt: new Date().toISOString() };
    }
    this.saveState(state);
    return state;
  }
  upsertHunt(key, patch) {
    const state = this.loadState();
    state.hunts[key] = { ...(state.hunts[key] || {}), ...patch };
    this.saveState(state);
    return state.hunts[key];
  }
  appendEvent(event) {
    fs.appendFileSync(this.files.events, JSON.stringify(event) + '\n', { mode: 0o600 });
  }
  tailEvents(limit = 100) {
    try {
      const lines = fs.readFileSync(this.files.events, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(1000, limit))).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
  hasSeen(id) {
    const seen = this._readJson(this.files.seen, {});
    return !!seen[id];
  }
  markSeen(id) {
    const seen = this._readJson(this.files.seen, {});
    seen[id] = Date.now();
    const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 3000);
    atomicWrite(this.files.seen, Object.fromEntries(entries));
  }
  loadOutbox() { return this._readJson(this.files.outbox, []); }
  saveOutbox(list) { atomicWrite(this.files.outbox, list); }
  enqueue(item, dedupeKey) {
    const list = this.loadOutbox();
    const key = dedupeKey || item.dedupeKey;
    if (key && list.some(entry => entry.dedupeKey === key)) return list;
    list.push({ ...item, id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, dedupeKey: key || null, attempts: 0, createdAt: new Date().toISOString() });
    this.saveOutbox(list);
    return list;
  }
  removeFromOutbox(id) { this.saveOutbox(this.loadOutbox().filter(item => item.id !== id)); }
  markAttempt(id, err) {
    const list = this.loadOutbox();
    const item = list.find(x => x.id === id);
    if (item) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = String(err || '').slice(0, 300);
      item.lastAttemptAt = new Date().toISOString();
      this.saveOutbox(list);
    }
  }
}

module.exports = { Store, atomicWrite };
