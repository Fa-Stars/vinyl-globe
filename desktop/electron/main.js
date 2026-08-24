'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { clearRuntimeCache } = require('../../runtime-cache');

let mainWindow = null;
let backend = null;
let backendPort = null;
let quitting = false;

function appRoot() {
  // web/server.js 和 web/public/ 会在生产构建中放到 asarUnpack，便于子进程直接读取。
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.resolve(__dirname, '../..');
}

function publicRoot() {
  return path.join(appRoot(), 'web', 'public');
}

function dataRoot() {
  return path.join(app.getPath('userData'), 'data');
}

function configPath() {
  return path.join(dataRoot(), 'config.json');
}

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch (e) {
    return {};
  }
}

function normalizeClientId(value) {
  const id = String(value == null ? '' : value).trim();
  // client_id 是外部服务凭证，只接受短文本，拒绝控制字符和过大的输入。
  if (id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function writeConfig(clientId) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ jamendoClientId: clientId }, null, 2) + '\n', 'utf8');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : null;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function pipeBackendLogs(child) {
  if (child.stdout) child.stdout.on('data', (chunk) => console.log('[backend] ' + chunk.toString().trimEnd()));
  if (child.stderr) child.stderr.on('data', (chunk) => console.error('[backend] ' + chunk.toString().trimEnd()));
}

function probeBackend(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(port) {
  for (let i = 0; i < 80; i++) {
    if (await probeBackend(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('本地服务启动超时');
}

function stopBackend() {
  return new Promise((resolve) => {
    const child = backend;
    backend = null;
    backendPort = null;
    if (!child || child.killed) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish();
    }, 2500);
    child.once('exit', finish);
    try { child.kill(); } catch (e) { finish(); }
  });
}

async function startBackend(portOverride) {
  const port = portOverride || await findFreePort();
  const script = path.join(appRoot(), 'web', 'server.js');
  const env = {
    ...process.env,
    // Electron 的可执行文件作为子进程运行时，切换为 Node 兼容模式。
    ELECTRON_RUN_AS_NODE: '1',
    // 由桌面设置管理配置，避免继承外部环境变量覆盖界面中的设置。
    JAMENDO_CLIENT_ID: '',
    // Electron 主进程会在后端退出后统一清理，避免后端重启时误删缓存。
    WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '0',
    // Desktop 窗口生命周期由 Electron 管理，不启用 Web 页面会话退出逻辑。
    WORLD_VINYL_BROWSER_LIFECYCLE: '0',
    WORLD_VINYL_DATA_DIR: dataRoot(),
    WORLD_VINYL_PUBLIC_DIR: publicRoot(),
    WORLD_VINYL_HOST: '127.0.0.1',
    WORLD_VINYL_PORT: String(port),
  };
  const child = fork(script, [], {
    cwd: appRoot(),
    env,
    silent: true,
  });
  backend = child;
  backendPort = port;
  pipeBackendLogs(child);
  child.once('error', (error) => {
    console.error('[backend] process error:', error);
  });
  child.once('exit', (code, signal) => {
    if (!quitting && backend === child) {
      backend = null;
      backendPort = null;
      console.error('[backend] exited unexpectedly:', code, signal || '');
    }
  });
  try {
    await waitForBackend(port);
  } catch (error) {
    try { child.kill(); } catch (e) { /* ignore */ }
    backend = null;
    backendPort = null;
    throw error;
  }
}

async function restartBackend() {
  const port = backendPort;
  await stopBackend();
  await startBackend(port);
}

function settingsForUi() {
  const id = normalizeClientId(readConfig().jamendoClientId) || '';
  return { jamendoClientId: id, mode: id ? 'jamendo' : 'itunes' };
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settingsForUi());
  ipcMain.handle('settings:save', async (_event, value) => {
    const id = normalizeClientId(value);
    if (id === null) return { ok: false, error: 'client_id 格式不正确' };
    const previous = normalizeClientId(readConfig().jamendoClientId) || '';
    if (id === previous) return { ok: true, changed: false, mode: id ? 'jamendo' : 'itunes' };
    try {
      writeConfig(id);
      await restartBackend();
      return { ok: true, changed: true, mode: id ? 'jamendo' : 'itunes' };
    } catch (error) {
      try {
        writeConfig(previous);
        await restartBackend();
      } catch (restoreError) {
        console.error('[settings] restore failed:', restoreError);
      }
      return { ok: false, error: error.message || '保存设置失败' };
    }
  });
  ipcMain.handle('app:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 760,
    backgroundColor: '#0b0d13',
    title: '世界唱片机 · World Vinyl',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL('http://127.0.0.1:' + backendPort + '/');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  registerIpc();
  try {
    await startBackend();
    await createWindow();
  } catch (error) {
    console.error('[main] startup failed:', error.stack || error);
    dialog.showErrorBox('世界唱片机启动失败', error.message || String(error));
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null && backendPort) createWindow().catch((error) => console.error(error));
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (backend) {
    event.preventDefault();
    stopBackend().finally(() => {
      clearRuntimeCache(dataRoot(), (error) => console.warn('[main] cache cleanup failed:', error.message));
      console.log('[main] runtime cache cleared; config.json preserved');
      app.quit();
    });
  } else {
    clearRuntimeCache(dataRoot(), (error) => console.warn('[main] cache cleanup failed:', error.message));
    console.log('[main] runtime cache cleared; config.json preserved');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
