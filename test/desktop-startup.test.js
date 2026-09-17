'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const mainPath = path.join(projectRoot, 'desktop', 'electron', 'main.js');

function createElectronStub() {
  const handlers = new Map();
  const listeners = new Map();
  const state = { loadedUrl: null, quitCalls: 0, error: null };

  const app = {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, 'userData');
      return path.join(projectRoot, 'test', '.desktop-startup-user-data');
    },
    whenReady: () => Promise.resolve(),
    on(event, listener) {
      listeners.set(event, listener);
    },
    quit() {
      state.quitCalls++;
    },
  };

  class BrowserWindow {
    constructor() {
      this.webContents = { setWindowOpenHandler() {} };
    }

    loadURL(url) {
      state.loadedUrl = url;
      return Promise.resolve();
    }

    on() {}
  }

  return {
    electron: {
      app,
      BrowserWindow,
      dialog: { showErrorBox(_title, error) { state.error = error; } },
      ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
      shell: { openExternal() {} },
    },
    state,
    handlers,
    listeners,
  };
}

function createChildProcessStub(forkCalls) {
  return {
    fork(script, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      forkCalls.push({ script, args, options, child });
      return child;
    },
  };
}

function createNetworkStubs(selectedPort, probeCalls) {
  return {
    net: {
      createServer() {
        return {
          once() {},
          listen(_port, _host, callback) { callback(); },
          address() { return { port: selectedPort }; },
          close(callback) { callback(); },
        };
      },
    },
    http: {
      get(options, callback) {
        probeCalls.push(options);
        queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
        return {
          on() { return this; },
          destroy() {},
        };
      },
    },
  };
}

async function bootMain({ inheritedPort, selectedPort }) {
  const electron = createElectronStub();
  const forkCalls = [];
  const probeCalls = [];
  const childProcess = createChildProcessStub(forkCalls);
  const network = createNetworkStubs(selectedPort, probeCalls);
  const nodeRequire = Module.createRequire(mainPath);
  const source = fs.readFileSync(mainPath, 'utf8');
  const context = {
    console,
    Promise,
    URL,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    process: {
      env: { ...process.env, PORT: String(inheritedPort) },
      platform: process.platform,
      resourcesPath: process.resourcesPath,
    },
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
    require(request) {
      if (request === 'electron') return electron.electron;
      if (request === 'child_process') return childProcess;
      if (request === 'net') return network.net;
      if (request === 'http') return network.http;
      return nodeRequire(request);
    },
  };
  vm.runInNewContext(source, context, { filename: mainPath });

  const deadline = Date.now() + 2000;
  while (!electron.state.loadedUrl && !electron.state.error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(electron.state.error, null);
  assert.ok(electron.state.loadedUrl, 'desktop window did not finish loading');
  return { ...electron, forkCalls, probeCalls };
}

test('desktop backend launch pins both port environment variables to the selected port', async () => {
  const inheritedPort = 43124;
  const selectedPort = 43123;
  const result = await bootMain({ inheritedPort, selectedPort });
  assert.equal(result.forkCalls.length, 1);
  const launch = result.forkCalls[0];
  assert.equal(launch.options.env.PORT, String(selectedPort));
  assert.equal(launch.options.env.WORLD_VINYL_PORT, String(selectedPort));
  assert.equal(result.probeCalls[0].port, selectedPort);
  assert.match(result.state.loadedUrl, new RegExp(':' + selectedPort + '/$'));
});
