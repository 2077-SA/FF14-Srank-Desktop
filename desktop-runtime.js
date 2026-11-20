'use strict';
/* Renderer-side desktop integration. This script never receives Node.js access. */
(function FF14DesktopRuntime() {
  const api = window.ff14Desktop;
  if (!api) return; // Keep the same HTML usable in a normal browser for recovery/export.

  const MAX_IMPORT_ITEMS = 12000;
  const PREFIXES = ['ff14_', 'triggerMonitor.', 'ff14-v3', 'ff14Monitor'];
  const SECRET_KEY = /(password|passwd|cookie|csrf|session|authorization|api.?token|invite|permission|master_verified|developer_mode|auth)/i;
  const isAppKey = key => PREFIXES.some(prefix => String(key).startsWith(prefix));
  const isSafeKey = key => isAppKey(key) && !SECRET_KEY.test(String(key));

  // Desktop backend uses a dedicated port to avoid colliding with the old CMD bridge.
  window.FF14BearBridgeConfig = Object.assign({}, window.FF14BearBridgeConfig || {}, {
    baseUrl: 'http://127.0.0.1:8788'
  });

  function collectSafeEntries() {
    const entries = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !isSafeKey(key)) continue;
      const value = localStorage.getItem(key);
      if (typeof value === 'string') entries[key] = value;
    }
    return entries;
  }

  function notify(message, isError = false) {
    try {
      if (typeof window.showToast === 'function') window.showToast(message, isError ? 'error' : 'success');
      else console[isError ? 'error' : 'info']('[FF14 Desktop]', message);
    } catch { console.info('[FF14 Desktop]', message); }
  }

  api.onLegacyImport(async payload => {
    const incoming = payload?.entries;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      notify('导入失败：备份数据结构无效。', true);
      return;
    }
    const pairs = Object.entries(incoming);
    if (pairs.length > MAX_IMPORT_ITEMS || pairs.some(([key, value]) => !isSafeKey(key) || typeof value !== 'string')) {
      notify('导入失败：发现不允许恢复的字段或数据项过多。', true);
      return;
    }

    const before = collectSafeEntries();
    try {
      const backupResult = await api.savePreImportBackup({ entries: before });
      if (!backupResult?.ok) throw new Error('迁移前自动备份未成功，已取消导入。');
      let applied = 0;
      for (const [key, value] of pairs) {
        localStorage.setItem(key, value);
        applied++;
      }
      notify(`旧版数据迁移完成：恢复 ${applied} 项。已自动备份迁移前数据。`);
      setTimeout(() => location.reload(), 650);
    } catch (error) {
      // Roll back partially written keys from the snapshot captured above.
      try {
        const currentKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && isSafeKey(key)) currentKeys.push(key);
        }
        for (const key of currentKeys) if (!(key in before)) localStorage.removeItem(key);
        for (const [key, value] of Object.entries(before)) localStorage.setItem(key, value);
      } catch (rollbackError) {
        console.error('[FF14 Desktop] rollback failed', rollbackError);
      }
      notify(`数据迁移失败，已尝试回滚：${error.message || error}`, true);
    }
  });

  api.onRequestExport(async () => {
    try {
      const entries = collectSafeEntries();
      const result = await api.saveExport({ entries });
      if (result?.ok) notify(`桌面版数据备份已导出：${result.count} 项。`);
      else if (!result?.canceled) notify('导出备份失败。', true);
    } catch (error) {
      notify(`导出备份失败：${error.message || error}`, true);
    }
  });

  api.onBridgeExited(info => {
    notify(`S 怪同步后台已退出（代码 ${info?.code ?? '未知'}）。可从“同步”菜单查看日志。`, true);
  });

  window.FF14DesktopRuntime = Object.freeze({
    version: api.version,
    exportEntries: collectSafeEntries,
    getBridgeHealth: api.getBridgeHealth
  });
  console.info(`[FF14 Desktop] 桌面环境已就绪 v${api.version}；本地 S 怪桥接地址：127.0.0.1:8788`);
})();
