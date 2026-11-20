'use strict';
const path = require('node:path');

const APP_PREFIXES = ['ff14_', 'triggerMonitor.', 'ff14-v3', 'ff14Monitor'];
const SENSITIVE_KEY = /(password|passwd|cookie|csrf|session|authorization|api.?token|invite|permission|master_verified|developer_mode|auth)/i;
const MAX_BACKUP_BYTES = 80 * 1024 * 1024;
const VERSION = '4.0.0';

function isAppStorageKey(key) {
  const value = String(key || '');
  return APP_PREFIXES.some(prefix => value.startsWith(prefix));
}

function isSensitiveStorageKey(key) {
  return SENSITIVE_KEY.test(String(key || ''));
}

function sanitizeEntries(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('备份 entries 必须是对象。');
  }
  const safe = {};
  let skipped = 0;
  let totalBytes = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!isAppStorageKey(key) || isSensitiveStorageKey(key) || typeof value !== 'string') {
      skipped++;
      continue;
    }
    const bytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    totalBytes += bytes;
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error('本地数据超过 80 MB 安全上限。');
    safe[key] = value;
  }
  return { entries: safe, skipped, count: Object.keys(safe).length, totalBytes };
}

function validateLegacyBackup(payload) {
  if (!payload || payload.schema !== 'ff14-toolbox-local-backup' || payload.schemaVersion !== 1) {
    throw new Error('这不是受支持的 FF14 工具箱本地备份（需要 schema v1）。');
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (serializedBytes > MAX_BACKUP_BYTES) throw new Error('备份文件超过 80 MB 安全上限。');
  const sanitized = sanitizeEntries(payload.entries);
  return {
    schema: 'ff14-toolbox-local-backup',
    schemaVersion: 1,
    appVersion: String(payload.appVersion || 'unknown').slice(0, 32),
    createdAt: payload.createdAt || null,
    entries: sanitized.entries,
    count: sanitized.count,
    skipped: sanitized.skipped,
    totalBytes: sanitized.totalBytes
  };
}

function buildBridgeConfig(userDataPath) {
  const userData = path.resolve(userDataPath);
  return {
    tracker: {
      restBase: 'https://tracker.beartoolkit.com',
      origin: 'https://tracker.beartoolkit.com'
    },
    watch: {
      dataCenters: ['陆行鸟'],
      worlds: [],
      sRankRefreshSec: 900,
      sRankConcurrency: 2,
      sRankRequestDelayMs: 450
    },
    local: {
      host: '127.0.0.1',
      port: 8788,
      allowedOrigins: ['app://bundle'],
      webhookUrl: '',
      webhookTimeoutMs: 8000,
      webhookSecret: ''
    },
    sync: {
      allowUpstreamReports: false,
      queueTransientFailures: false,
      maxOutboxAttempts: 0
    },
    aliases: {},
    paths: {
      dataDir: path.join(userData, 'bear-bridge-data')
    }
  };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function resolveInside(root, relativePath) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('资源路径越界。');
  }
  return resolved;
}

module.exports = {
  APP_PREFIXES,
  MAX_BACKUP_BYTES,
  VERSION,
  isAppStorageKey,
  isSensitiveStorageKey,
  sanitizeEntries,
  validateLegacyBackup,
  buildBridgeConfig,
  safeTimestamp,
  resolveInside
};
