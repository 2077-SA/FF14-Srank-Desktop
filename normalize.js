'use strict';

const RANK_BY_CODE = { 1: 'a', 2: 'b', 3: 'b+', 5: 's' };
const first = (obj, keys) => {
  for (const key of keys) if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  return null;
};

function toUnixSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

function isoFromUnix(value) {
  const sec = toUnixSeconds(value);
  if (!sec) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getHuntDefinition(name, resources) {
  const db = resources?.DatabaseHunt || {};
  if (!name) return null;
  if (db[name]) return db[name];
  const needle = String(name).toLowerCase();
  const key = Object.keys(db).find(k => String(k).toLowerCase() === needle);
  return key ? db[key] : null;
}

function computeWindow(lastDeathValue, definition, isMaint) {
  const base = toUnixSeconds(lastDeathValue);
  const arr = isMaint ? definition?.MaintTimer : definition?.RespawnTimer;
  if (!base || !Array.isArray(arr) || arr.length < 2) return null;
  const minH = Number(arr[0]);
  const maxH = Number(arr[1]);
  if (!Number.isFinite(minH) || !Number.isFinite(maxH) || minH < 0 || maxH < minH) return null;
  return {
    start: isoFromUnix(base + minH * 3600),
    end: isoFromUnix(base + maxH * 3600),
    startTs: base + minH * 3600,
    endTs: base + maxH * 3600,
    minHours: minH,
    maxHours: maxH
  };
}

function normalizeEvent(name, payload, resources) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const hunt = first(p, ['Hunt', 'HuntName', 'hunt', 'huntName', 'Name']);
  const fate = first(p, ['Fate', 'FATE', 'FateName', 'fateName']);
  const huntName = hunt || fate;
  const worldName = first(p, ['World', 'WorldName', 'world', 'worldName']);
  const def = getHuntDefinition(huntName, resources) || getHuntDefinition(fate, resources);
  const rankCode = first(def, ['Rank', 'rank']);
  const rank = RANK_BY_CODE[Number(rankCode)] || (typeof rankCode === 'string' ? rankCode.toLowerCase() : null);
  const rawTime = first(p, ['Time', 'ReportTime', 'Timestamp', 'time', 'timestamp']);
  const time = toUnixSeconds(rawTime);
  const base = { source: 'socket', event: name, receivedAt: new Date().toISOString() };

  switch (name) {
    case 'DeathReport': {
      const mark = toUnixSeconds(first(p, ['LastMarkTime', 'lastMarkTime', 'LastDeathTime']));
      const maint = Boolean(first(p, ['MaintState', 'IsMaint', 'isMaint', 'maint']));
      return {
        ...base, type: 'death', huntName, worldName, time, at: isoFromUnix(time), rank,
        region: def?.Region || def?.region || null, patch: def?.Patch || def?.patch || null,
        missing: Number(first(p, ['MissingCounter', 'Missing', 'missingCounter'])) || 0,
        maint, lastMarkTime: mark,
        window: def ? computeWindow(mark || time, def, maint) : null,
        raw: p
      };
    }
    case 'FoundReport':
      return { ...base, type: 'found', huntName, worldName, time, at: isoFromUnix(time), rank,
        progress: first(p, ['Progress', 'progress']), position: first(p, ['Position', 'position']),
        reporter: first(p, ['Reporter', 'reporter']), patch: def?.Patch || null, raw: p };
    case 'FATEUpdate':
      return { ...base, type: 'fate', huntName, worldName, time, at: isoFromUnix(time),
        progress: first(p, ['Progress', 'progress']), raw: p };
    case 'SRankFATEUpdate': {
      const lastSeen = toUnixSeconds(first(p, ['LastSeen', 'lastSeen']));
      const lastDeath = toUnixSeconds(first(p, ['LastDeath', 'lastDeath', 'LastDeathTime']));
      return { ...base, type: 'srank_fate', huntName, worldName, rank,
        lastSeen, lastDeath, time: lastDeath || lastSeen, at: isoFromUnix(lastDeath || lastSeen), raw: p };
    }
    case 'SRankMappingReport':
      return { ...base, type: 'spawnpoint', huntName, worldName,
        position: first(p, ['Position', 'position']), time, at: isoFromUnix(time),
        verified: Boolean(first(p, ['Verified', 'verified'])), reporter: first(p, ['Reporter', 'reporter']),
        notification: first(p, ['Notification', 'notification']), raw: p };
    default:
      return { ...base, type: 'unknown', payload: p };
  }
}

function normalizeTimer(timer, resources) {
  const t = timer && typeof timer === 'object' ? timer : {};
  const huntName = first(t, ['huntName', 'HuntName', 'Hunt', 'hunt', 'name']);
  const worldName = first(t, ['worldName', 'WorldName', 'World', 'world']);
  const def = getHuntDefinition(huntName, resources) || getHuntDefinition(first(t, ['huntKey', 'HuntKey']), resources);
  const lastDeath = toUnixSeconds(first(t, ['lastDeathTime', 'LastDeathTime', 'lastDeath', 'LastDeath', 'Time']));
  const lastMark = toUnixSeconds(first(t, ['lastMarkTime', 'LastMarkTime', 'LastMark']));
  const isMaint = Boolean(first(t, ['isMaint', 'IsMaint', 'MaintState', 'maint']));
  const rankCode = first(def, ['Rank', 'rank']);
  return {
    huntName: huntName || null,
    huntKey: first(t, ['huntKey', 'HuntKey']) || huntName || null,
    worldName: worldName || null,
    instance: Number(first(t, ['instance', 'Instance'])) || 0,
    rank: RANK_BY_CODE[Number(rankCode)] || null,
    rankCode: rankCode == null ? null : Number(rankCode),
    region: def?.Region || def?.region || null,
    patch: def?.Patch || def?.patch || null,
    lastDeathTime: lastDeath,
    lastDeathAt: isoFromUnix(lastDeath),
    lastMarkTime: lastMark,
    missingCounter: Number(first(t, ['missingCounter', 'MissingCounter', 'Missing'])) || 0,
    maint: isMaint,
    reporter: first(t, ['reporter', 'Reporter']) || null,
    window: def ? computeWindow(lastMark || lastDeath, def, isMaint) : null,
    updatedAt: new Date().toISOString()
  };
}

const TIME_KEYS = new Set([
  'time', 'reporttime', 'timestamp', 'datetime', 'date', 'death', 'deathtime',
  'lastdeath', 'lastdeathtime', 'reportedat', 'createdat', 'created', 'occurredat',
  'unix', 'unixtime', 'epoch', 'value'
]);
const CONTAINER_KEYS = new Set([
  'data', 'result', 'results', 'record', 'report', 'death', 'previousdeath',
  'previousstate', 'state', 'history', 'item', 'details', 'huntinfo', 'hunt_info'
]);

function validHuntTimestamp(value) {
  const sec = toUnixSeconds(value);
  if (!sec) return null;
  // Hunt report history predates the game, but cannot reasonably be before 2000
  // or materially in the future. This also prevents IDs/counts being treated as dates.
  const now = Math.floor(Date.now() / 1000);
  return sec >= 946684800 && sec <= now + 7 * 86400 ? sec : null;
}

function timestampInside(value, depth = 0) {
  if (depth > 7 || value == null) return null;
  if (typeof value === 'number' || typeof value === 'string') return validHuntTimestamp(value);
  if (Array.isArray(value)) {
    for (const item of value) { const found = timestampInside(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  const entries = Object.entries(value);
  for (const [key, child] of entries) {
    if (TIME_KEYS.has(String(key).toLowerCase().replace(/[-_]/g, ''))) {
      const found = timestampInside(child, depth + 1);
      if (found) return found;
    }
  }
  for (const [key, child] of entries) {
    const normalized = String(key).toLowerCase().replace(/[-_]/g, '');
    if (CONTAINER_KEYS.has(normalized)) {
      const found = timestampInside(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findNamedValue(root, wanted, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 6) return undefined;
  for (const [key, value] of Object.entries(root)) {
    if (wanted.has(String(key).toLowerCase())) return value;
  }
  for (const [key, value] of Object.entries(root)) {
    const normalized = String(key).toLowerCase();
    if (CONTAINER_KEYS.has(normalized.replace(/[-_]/g, '')) && value && typeof value === 'object') {
      const found = findNamedValue(value, wanted, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Anonymous /api/huntInfo parser. The observed response exposes previousDeath,
 * previousState and count. Only previousDeath (or an explicit timestamp nested
 * inside it) is accepted as a kill anchor; state text and report counts never are.
 */
function normalizeHuntInfo(huntName, worldName, response, definition) {
  const root = response && typeof response === 'object' ? response : {};
  const previousDeath = findNamedValue(root, new Set(['previousdeath', 'previous_death']));
  const previousState = findNamedValue(root, new Set(['previousstate', 'previous_state']));
  const lastDeathTime = timestampInside(previousDeath);
  const rankCode = Number(definition?.Rank ?? definition?.rank);
  if (!lastDeathTime || rankCode !== 5) return null;
  return {
    huntName: String(huntName),
    worldName: String(worldName),
    rank: 's',
    rankCode: 5,
    region: definition?.Region || definition?.region || null,
    patch: definition?.Patch || definition?.patch || null,
    lastDeathTime,
    lastDeathAt: isoFromUnix(lastDeathTime),
    count: Number(first(root, ['count', 'Count'])) || null,
    previousStateKind: previousState == null ? null : Array.isArray(previousState) ? 'array' : typeof previousState,
    source: 'anonymous-huntInfo',
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  normalizeEvent, normalizeTimer, normalizeHuntInfo, isoFromUnix,
  computeWindow, toUnixSeconds, RANK_BY_CODE, timestampInside
};
