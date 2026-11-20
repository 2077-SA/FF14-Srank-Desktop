'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const DEFAULTS = {
  tracker: {
    restBase: 'https://tracker.beartoolkit.com',
    origin: 'https://tracker.beartoolkit.com'
  },
  // Bear 用户名只作为展示信息；密码不会写入配置文件。
  auth: { username: '', password: '', cookie: '', csrfToken: '', apiToken: '' },
  watch: { dataCenters: ['陆行鸟'], worlds: [], sRankRefreshSec: 900, sRankConcurrency: 3, sRankRequestDelayMs: 350 },
  local: {
    host: '127.0.0.1', port: 8787,
    allowedOrigins: ['null', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    webhookUrl: '', webhookTimeoutMs: 8000, webhookSecret: ''
  },
  sync: { allowUpstreamReports: false, queueTransientFailures: false, maxOutboxAttempts: 0 },
  aliases: {},
  paths: { dataDir: 'data' }
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    if (value === undefined || value === null) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else out[key] = value;
  }
  return out;
}

function load() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = deepMerge(DEFAULTS, user);
  cfg.root = ROOT;
  cfg.configPath = CONFIG_PATH;
  cfg.dataDir = path.resolve(ROOT, cfg.paths.dataDir || 'data');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

function save(cfg) {
  // 不把密码、Cookie、CSRF 或 API token 写进 config.json。
  const serializable = {
    tracker: cfg.tracker,
    watch: cfg.watch,
    local: cfg.local,
    sync: cfg.sync,
    aliases: cfg.aliases,
    paths: cfg.paths
  };
  fs.mkdirSync(path.dirname(cfg.configPath || CONFIG_PATH), { recursive: true });
  fs.writeFileSync(cfg.configPath || CONFIG_PATH, JSON.stringify(serializable, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfg.configPath || CONFIG_PATH, 0o600); } catch {}
}

module.exports = { load, save, DEFAULTS, ROOT, CONFIG_PATH };
