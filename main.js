'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  VERSION, MAX_BACKUP_BYTES, validateLegacyBackup, sanitizeEntries,
  buildBridgeConfig, safeTimestamp, resolveInside
} = require('./desktop-helpers');

const APP_SCHEME = 'app';
const APP_HOST = 'bundle';
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 8788;
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const APP_TITLE = `FF14 Srank Desktop v${VERSION}`;

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true }
}]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let mainWindow = null;
  let bridgeProcess = null;
  let bridgeOwned = false;
  let shuttingDown = false;
  let bridgeLogPath = '';
  let bridgeErrorLogPath = '';

  app.setName('FF14 Srank Desktop');
  const userData = app.getPath('userData');
  const appRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'app') : path.join(__dirname, 'app');
  const bridgeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bridge')
    : path.join(__dirname, 'bridge');
  const bridgeEntry = path.join(bridgeRoot, 'src', 'index.js');
  const configPath = path.join(userData, 'bridge-config.json');
  const logDir = path.join(userData, 'logs');
  const backupDir = path.join(userData, 'backups');

  app.setAppUserModelId('com.ff14.srank.desktop');

  function ensureFolders() {
    for (const dir of [userData, logDir, backupDir, path.join(userData, 'bear-bridge-data')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    bridgeLogPath = path.join(logDir, 'bear-bridge.log');
    bridgeErrorLogPath = path.join(logDir, 'bear-bridge-error.log');
  }

  function writeJsonAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, filePath);
  }

  function prepareBridgeConfig() {
    ensureFolders();
    const defaultConfig = buildBridgeConfig(userData);
    let current = defaultConfig;
    if (fs.existsSync(configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        current = {
          ...defaultConfig,
          ...parsed,
          tracker: { ...defaultConfig.tracker, ...(parsed.tracker || {}) },
          watch: { ...defaultConfig.watch, ...(parsed.watch || {}) },
          local: { ...defaultConfig.local, ...(parsed.local || {}) },
          sync: { ...defaultConfig.sync, ...(parsed.sync || {}), allowUpstreamReports: false, queueTransientFailures: false, maxOutboxAttempts: 0 },
          aliases: parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
          paths: { ...defaultConfig.paths, ...(parsed.paths || {}), dataDir: path.join(userData, 'bear-bridge-data') }
        };
      } catch (error) {
        fs.copyFileSync(configPath, `${configPath}.invalid-${safeTimestamp()}.bak`);
        current = defaultConfig;
      }
    }
    current.local.host = BRIDGE_HOST;
    current.local.port = BRIDGE_PORT;
    current.local.allowedOrigins = ['app://bundle'];
    current.paths.dataDir = path.join(userData, 'bear-bridge-data');
    current.sync = { ...(current.sync || {}), allowUpstreamReports: false, queueTransientFailures: false, maxOutboxAttempts: 0 };
    // This desktop release is anonymous, read-only, and S-rank only.
    delete current.auth;
    writeJsonAtomic(configPath, current);
  }

  async function bridgeHealth(timeoutMs = 850) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${BRIDGE_URL}/health`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  function appendLog(file, chunk) {
    if (!chunk) return;
    fs.appendFile(file, String(chunk), () => {});
  }

  async function startBridge() {
    prepareBridgeConfig();
    const existing = await bridgeHealth();
    if (existing?.ok && existing?.mode === 'anonymous-srank') {
      appendLog(bridgeLogPath, `[desktop] Reusing existing S-rank bridge at ${BRIDGE_URL}\n`);
      return { reused: true, health: existing };
    }
    if (existing) {
      appendLog(bridgeErrorLogPath, `[desktop] Port ${BRIDGE_PORT} is occupied by an unknown local service; not terminating it.\n`);
      return { reused: false, conflict: true };
    }
    if (!fs.existsSync(bridgeEntry)) throw new Error(`找不到桥接后台入口：${bridgeEntry}`);
    const env = { ...process.env, BRIDGE_CONFIG: configPath, NODE_ENV: app.isPackaged ? 'production' : 'development' };
    bridgeProcess = utilityProcess.fork(bridgeEntry, [], {
      serviceName: 'FF14 Srank Bear S Sync Service',
      cwd: bridgeRoot,
      env,
      stdio: 'pipe'
    });
    bridgeOwned = true;
    bridgeProcess.stdout?.on('data', chunk => appendLog(bridgeLogPath, chunk));
    bridgeProcess.stderr?.on('data', chunk => appendLog(bridgeErrorLogPath, chunk));
    bridgeProcess.on('spawn', () => appendLog(bridgeLogPath, `[desktop] Bridge process started; pid=${bridgeProcess.pid || 'pending'}\n`));
    bridgeProcess.on('exit', code => {
      appendLog(bridgeErrorLogPath, `[desktop] Bridge process exited with code ${code}\n`);
      bridgeProcess = null;
      if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:bridge-exited', { code });
      }
    });
    return { reused: false, started: true };
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
  };
  const CSP = [
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net blob: 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${BRIDGE_URL} https: wss: ws://127.0.0.1:17865`,
    "worker-src 'self' blob: https:",
    "font-src 'self' data: https:",
    "frame-src 'self' https: blob:",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ');

  async function registerAppProtocol() {
    await protocol.handle(APP_SCHEME, async request => {
      try {
        const parsed = new URL(request.url);
        if (parsed.hostname !== APP_HOST) return new Response('Not Found', { status: 404 });
        let relative = decodeURIComponent(parsed.pathname || '/').replace(/^\/+/, '');
        if (!relative || relative.endsWith('/')) relative += 'index.html';
        const filePath = resolveInside(appRoot, relative);
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return new Response('Not Found', { status: 404 });
        const body = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Security-Policy': CSP,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
          }
        });
      } catch {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    });
  }

  function senderIsMain(event) {
    return !!mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
  }

  function registerIpc() {
    ipcMain.handle('desktop:save-pre-import-backup', async (event, payload) => {
      if (!senderIsMain(event)) throw new Error('非法 IPC 来源。');
      const safe = sanitizeEntries(payload?.entries || {});
      const backup = {
        schema: 'ff14-toolbox-local-backup', schemaVersion: 1,
        appVersion: VERSION, exportFormat: 'ff14-toolbox-local-backup-v1',
        storageEncoding: 'localStorage-string-v1', createdAt: new Date().toISOString(),
        keyCount: safe.count, entries: safe.entries,
        note: '导入旧版数据前自动创建的桌面端回滚备份。'
      };
      const destination = path.join(backupDir, `pre-import-${safeTimestamp()}.json`);
      writeJsonAtomic(destination, backup);
      return { ok: true, path: destination, count: safe.count };
    });

    ipcMain.handle('desktop:save-export', async (event, payload) => {
      if (!senderIsMain(event)) throw new Error('非法 IPC 来源。');
      const safe = sanitizeEntries(payload?.entries || {});
      const backup = {
        schema: 'ff14-toolbox-local-backup', schemaVersion: 1,
        appVersion: VERSION, exportFormat: 'ff14-toolbox-local-backup-v1',
        storageEncoding: 'localStorage-string-v1', createdAt: new Date().toISOString(),
        keyCount: safe.count, entries: safe.entries
      };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 FF14 Srank 桌面版备份',
        defaultPath: path.join(app.getPath('documents'), `FF14_Srank_Desktop_v${VERSION}_backup_${safeTimestamp()}.json`),
        filters: [{ name: 'JSON 备份', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      writeJsonAtomic(result.filePath, backup);
      return { ok: true, path: result.filePath, count: safe.count };
    });

    ipcMain.handle('desktop:bridge-health', async event => {
      if (!senderIsMain(event)) throw new Error('非法 IPC 来源。');
      return await bridgeHealth(1800) || { ok: false, offline: true };
    });
  }

  async function importLegacyBackup() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: '选择旧版 FF14 工具箱备份',
      properties: ['openFile'],
      filters: [{ name: 'FF14 工具箱 JSON 备份', extensions: ['json'] }]
    });
    if (pick.canceled || !pick.filePaths[0]) return;
    let payload;
    try {
      const file = pick.filePaths[0];
      const stat = fs.statSync(file);
      if (stat.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 80 MB 安全上限。');
      payload = validateLegacyBackup(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      await dialog.showMessageBox(mainWindow, { type: 'error', title: '备份文件无法读取', message: error.message });
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '迁移旧版工具箱数据',
      message: `检测到 ${payload.count} 个可迁移的数据项。`,
      detail: `来源版本：${payload.appVersion}\n备份时间：${payload.createdAt || '未知'}\n跳过的敏感/非工具箱字段：${payload.skipped} 项。\n\n迁移前会先备份桌面版当前数据；随后仅覆盖同名键，其他桌面端数据保留。不会迁移登录凭据、权限标记或邀请码。`,
      buttons: ['取消', '备份并开始迁移'], defaultId: 1, cancelId: 0, noLink: true
    });
    if (result.response !== 1) return;
    mainWindow.webContents.send('desktop:legacy-import', payload);
  }

  function exportDesktopBackup() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:request-export');
  }

  async function showBridgeStatus() {
    const health = await bridgeHealth(2000);
    const message = health?.ok
      ? `本地桥接服务正常\n模式：${health.mode || '未知'}\n状态：${health.sync?.status || health.status || '未知'}\nS 怪缓存：${health.hunts ?? health.timerCount ?? 0}\n上次同步：${health.sync?.lastSyncAt || '尚未完成'}`
      : '本地 S 怪同步后台尚未就绪。请查看“打开运行日志”，或确认桥接进程未被安全软件拦截。';
    await dialog.showMessageBox(mainWindow, { type: health?.ok ? 'info' : 'warning', title: 'S 怪同步后台状态', message });
  }

  function buildMenu() {
    const template = [
      {
        label: '文件', submenu: [
          { label: '导入旧版工具箱备份 JSON…', click: importLegacyBackup },
          { label: '导出桌面版数据备份 JSON…', click: exportDesktopBackup },
          { type: 'separator' },
          { label: '打开数据文件夹', click: () => shell.openPath(userData) },
          { label: '打开运行日志', click: () => shell.openPath(logDir) },
          { type: 'separator' },
          { role: 'quit', label: '退出 FF14 Srank Desktop' }
        ]
      },
      {
        label: '同步', submenu: [
          { label: '查看 S 怪同步后台状态', click: showBridgeStatus },
          { label: '打开 Bear S 怪 CD 面板', click: () => mainWindow?.webContents.executeJavaScript("window.FF14UnifiedUtilityDock?.open('bear')") },
          { label: '立即同步 S 怪 CD', click: async () => {
            try {
              const response = await fetch(`${BRIDGE_URL}/sync/now`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              await dialog.showMessageBox(mainWindow, { type: 'info', title: '同步任务已提交', message: '免登录 S 怪同步已提交到后台；同步不会阻塞工具箱界面。' });
            } catch (error) {
              await dialog.showMessageBox(mainWindow, { type: 'warning', title: '同步服务暂不可用', message: error.message });
            }
          } }
        ]
      },
      {
        label: '窗口', submenu: [
          { role: 'reload', label: '重新加载界面' },
          { role: 'forceReload', label: '强制重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '恢复默认缩放' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { role: 'togglefullscreen', label: '切换全屏' }
        ]
      },
      {
        label: '帮助', submenu: [
          { label: '关于 FF14 Srank Desktop', click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: `FF14 Srank Desktop v${VERSION}`,
            message: `FF14 Srank Desktop v${VERSION}`,
            detail: '桌面外壳 v4.0.0，内置工具箱核心 v3.3.8。\nBear Tracker 当前采用匿名只读 S 怪同步，不登录、不向 Bear Tracker 写入数据。'
          }) }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1540, height: 1000, minWidth: 1080, minHeight: 720,
      show: false, autoHideMenuBar: false, title: APP_TITLE,
      backgroundColor: '#101522',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    });

    mainWindow.on('ready-to-show', () => {
      mainWindow.setTitle(APP_TITLE);
      mainWindow.show();
    });
    mainWindow.on('page-title-updated', event => {
      event.preventDefault();
      mainWindow?.setTitle(APP_TITLE);
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(url);
      } catch {}
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('app://bundle/')) {
        event.preventDefault();
        try {
          const parsed = new URL(url);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(url);
        } catch {}
      }
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL('app://bundle/index.html');
    return mainWindow;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureFolders();
    registerIpc();
    buildMenu();
    await registerAppProtocol();
    // Launch the S-rank sync backend in a separate utility process. The window is not held
    // open waiting for Bear Tracker's network; its first sync continues entirely in background.
    try { await startBridge(); }
    catch (error) { appendLog(bridgeErrorLogPath, `[desktop] Bridge start failed: ${error.stack || error}\n`); }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox('FF14 Srank Desktop 启动失败', error.stack || String(error));
    app.quit();
  });

  app.on('before-quit', () => {
    shuttingDown = true;
    if (bridgeOwned && bridgeProcess) {
      try { bridgeProcess.kill(); } catch {}
      bridgeProcess = null;
    }
  });
  app.on('window-all-closed', () => app.quit());
}
