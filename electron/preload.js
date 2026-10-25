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
    showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
    showOpenDirectory: (options) => ipcRenderer.invoke('show-open-directory', options),
    // 文件浏览页【打开文件】：弹系统文件选择框，返回绝对路径数组
    showOpenFiles: () => ipcRenderer.invoke('show-open-files'),
    revealPath: (path) => ipcRenderer.invoke('reveal-path', path),
    copySamplePpt: (dir) => ipcRenderer.invoke('copy-sample-ppt', dir),
    // 右键「打开方式」/ 拖 Dock / 命令行带进来的 PPT：主进程攒好后统一推过来
    onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, paths) => {
        try { cb(paths || []); } catch (err) { console.error('[PPTNest] onOpenFiles handler failed', err); }
    }),
    notifyReady: () => ipcRenderer.send('renderer-ready'),
});
