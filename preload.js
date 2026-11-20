'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('ff14Desktop', Object.freeze({
  version: '4.0.0',
  onLegacyImport: callback => subscribe('desktop:legacy-import', callback),
  onRequestExport: callback => subscribe('desktop:request-export', callback),
  onBridgeExited: callback => subscribe('desktop:bridge-exited', callback),
  savePreImportBackup: payload => ipcRenderer.invoke('desktop:save-pre-import-backup', payload),
  saveExport: payload => ipcRenderer.invoke('desktop:save-export', payload),
  getBridgeHealth: () => ipcRenderer.invoke('desktop:bridge-health')
}));
