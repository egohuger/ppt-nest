/**
 * PPT Nest - Electron Main Process
 * 管理窗口生命周期和 Python 后端进程
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const BACKEND_PORT_START = 18501;
let BACKEND_PORT = BACKEND_PORT_START;
let BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let mainWindow = null;
let pythonProcess = null;

// ─── Port discovery ─────────────────────────────────────────────────

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(startPort, maxTries = 20) {
    // Avoid conflicts with a leftover backend process or other local apps
    for (let i = 0; i < maxTries; i++) {
        const port = startPort + i;
        if (await isPortAvailable(port)) return port;
    }
    throw new Error('No available port found for the backend');
}

// ─── Find Python ────────────────────────────────────────────────────

function findPython() {
    const fs = require('fs');
    const cp = require('child_process');

    // 1. Bundled exe (production) — electron-builder extraResources
    const bundledExe = path.join(process.resourcesPath || '', 'backend', 'server.exe');
    if (fs.existsSync(bundledExe)) {
        return bundledExe;
    }

    // 2. Locally built exe (dev, via npm run build:python)
    const localExe = path.join(__dirname, '..', 'dist-python', 'server.exe');
    if (fs.existsSync(localExe)) {
        return localExe;
    }

    // 3. Hermes venv Python
    const hermesPy = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe');
    if (fs.existsSync(hermesPy)) {
        return hermesPy;
    }

    // 4. PATH-based Python
    const candidates = ['python', 'python3', 'py'];
    for (const cmd of candidates) {
        try {
            const result = cp.spawnSync(cmd, ['-c', 'print("ok")'], {
                timeout: 5000,
                windowsHide: true,
            });
            if (result.status === 0) {
                return cmd;
            }
        } catch (e) {
            continue;
        }
    }
    return null;  // nothing usable found
}

// ─── Python Backend ──────────────────────────────────────────────────

function startPythonBackend() {
    const python = findPython();
    if (!python) {
        dialog.showErrorBox(
            'Python 环境缺失',
            '未找到可用的 Python 运行环境，后端服务无法启动。\n\n' +
            '请安装 Python 3.10+ 并加入 PATH，或使用打包版（自带 server.exe）。'
        );
        return false;
    }
    const isExe = python.endsWith('.exe') && !python.endsWith('python.exe');

    // Resolve a real, persistent data directory (not inside ASAR)
    const fs = require('fs');
    const appDataDir = path.join(app.getPath('userData'), 'data');

    // Honor a user-configured data dir override (written by the backend's
    // Settings page into <appDataDir>/config.json). Without this, packaged
    // builds always reset to the default dir on restart.
    let resolvedDataDir = appDataDir;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(appDataDir, 'config.json'), 'utf8'));
        if (cfg && typeof cfg.data_dir === 'string' && cfg.data_dir.trim()) {
            resolvedDataDir = cfg.data_dir.trim();
        }
    } catch (e) { /* no override or unreadable — use default */ }

    // cwd: must be a real filesystem path, not inside ASAR virtual fs
    let cwd;
    if (isExe) {
        // Bundled exe: use the install/parent dir of the exe
        cwd = path.dirname(python);
    } else {
        cwd = path.join(__dirname, '..', 'backend');
        // In ASAR context, resolve to real path
        if (cwd.includes('app.asar')) {
            cwd = path.join(path.dirname(process.resourcesPath), 'resources');
        }
    }

    // Pass data dir to Python backend via env var.
    // In dev mode (non-packaged), let the backend use the project-relative 'data'
    // directory so thumbnails generated during standalone runs are found.
    const env = { ...process.env };
    if (app.isPackaged) {
        env.PPTNEST_DATA_DIR = resolvedDataDir;
        // Base dir = where the override config.json must be persisted,
        // so this launcher can pick it up on the next start.
        env.PPTNEST_BASE_DATA_DIR = appDataDir;
    }
    console.log(`[PPTNest] Data directory: ${app.isPackaged ? resolvedDataDir : '(project data/)'}`);

    if (isExe) {
        console.log(`[PPTNest] Starting bundled backend: ${python}`);
        pythonProcess = spawn(python, ['--port', String(BACKEND_PORT)], {
            cwd: cwd,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } else {
        const serverPath = path.join(__dirname, '..', 'backend', 'server.py');
        console.log(`[PPTNest] Starting Python backend: ${python} ${serverPath}`);
        pythonProcess = spawn(python, [serverPath, '--port', String(BACKEND_PORT)], {
            cwd: cwd,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
    }

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.log(`[Python:err] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`[PPTNest] Python backend exited with code ${code}`);
        pythonProcess = null;
    });

    pythonProcess.on('error', (err) => {
        console.error(`[PPTNest] Failed to start Python: ${err.message}`);
        pythonProcess = null;
        dialog.showErrorBox(
            '后端启动失败',
            `Python 进程无法启动：${err.message}\n\n请检查 Python 环境是否完整。`
        );
    });
    return true;
}

function stopPythonBackend() {
    if (pythonProcess) {
        console.log('[PPTNest] Stopping Python backend...');
        pythonProcess.kill();
        pythonProcess = null;
    }
}

// ─── Health check ───────────────────────────────────────────────────

function waitForBackend(retries = 30, delay = 500) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            attempts++;
            http.get(`${BACKEND_URL}/api/health`, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else if (attempts < retries) {
                    setTimeout(check, delay);
                } else {
                    reject(new Error('Backend health check failed'));
                }
            }).on('error', () => {
                if (attempts < retries) {
                    setTimeout(check, delay);
                } else {
                    reject(new Error('Backend not reachable after retries'));
                }
            });
        };
        check();
    });
}

// ─── Window ─────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'PPT Nest - 片巢',
        icon: path.join(__dirname, '..', 'frontend', 'icon.png'),
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        frame: true,
        titleBarStyle: 'default',
    });

    // Load the frontend
    mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));

    // DevTools: Ctrl+Shift+I to toggle
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.shift && input.key === 'I') {
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Open external links in browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ─── IPC Handlers ───────────────────────────────────────────────────

ipcMain.handle('get-backend-url', () => {
    return BACKEND_URL;
});

ipcMain.handle('get-data-dir', () => {
    return path.join(app.getPath('userData'), 'data');
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('open-external', async (event, filePath) => {
    try {
        await shell.openPath(filePath);
        return true;
    } catch (e) {
        console.error('Failed to open:', filePath, e);
        return false;
    }
});

ipcMain.handle('open-url', async (event, url) => {
    // 只允许安全协议，避免被利用调用任意协议处理器
    if (!/^(https?:|mailto:)/i.test(url)) {
        console.error('Blocked unsafe URL protocol:', url);
        return false;
    }
    try {
        await shell.openExternal(url);
        return true;
    } catch (e) {
        console.error('Failed to open URL:', url, e);
        return false;
    }
});

// ─── App Lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Pick a free port first — a leftover backend from a previous run
    // (or another local app) may still hold the default port.
    try {
        BACKEND_PORT = await findAvailablePort(BACKEND_PORT_START);
        BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
    } catch (e) {
        dialog.showErrorBox('端口不可用', e.message);
        app.quit();
        return;
    }

    const started = startPythonBackend();
    if (!started) {
        app.quit();
        return;
    }

    try {
        await waitForBackend();
        console.log('[PPTNest] Backend is ready on port', BACKEND_PORT);
    } catch (e) {
        console.error('[PPTNest] Warning: Backend may not be ready:', e.message);
        dialog.showErrorBox(
            '后端连接超时',
            'Python 后端服务未能在预期时间内就绪，应用将以离线模式打开。\n\n' +
            '可能原因：依赖未安装（运行 安装环境.bat）、杀毒软件拦截、或端口被占用。'
        );
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    stopPythonBackend();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopPythonBackend();
});
