/**
 * PPT Nest - Preload Script
 * 安全地暴露 API 给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    openExternal: (path) => ipcRenderer.invoke('open-external', path),
    openUrl: (url) => ipcRenderer.invoke('open-url', url),
});
