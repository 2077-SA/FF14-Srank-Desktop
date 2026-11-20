'use strict';
/** 本地桥接最小 SSE 监视器：node examples/watcher.js */
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const source = new EventSource(`${BRIDGE}/events`);
source.onopen = () => console.log('[sse] connected');
source.onmessage = event => {
  try {
    const data = JSON.parse(event.data);
    if (data.type !== 'hello') console.log(`[event] ${data.type} ${data.huntName || ''} @ ${data.worldName || ''}`, data.at || '');
  } catch (error) { console.warn('[sse] bad event', error.message); }
};
source.onerror = () => console.warn('[sse] disconnected; EventSource will retry');
