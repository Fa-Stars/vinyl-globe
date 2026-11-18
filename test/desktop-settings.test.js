'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const mainPath = path.resolve(__dirname, '../desktop/electron/main.js');

// Exercise the real IPC handlers and restart lifecycle without Electron,
// network requests, or reading/writing any real configuration.
async function bootDesktop() {
  const handlers = new Map();
  const listeners = new Map();
  const children = [];
  const state = { config: { jamendoClientId: 'previous' }, autoExit: false, failNextFork: false };
  let loaded;
  const ready = new Promise((resolve) => { loaded = resolve; });
  const electron = {
    app: {
      isPackaged: false,
      getPath: () => path.dirname(mainPath),
      whenReady: () => Promise.resolve(),
      on: (event, listener) => listeners.set(event, listener),
      quit() {},
    },
    BrowserWindow: class {
      constructor() { this.webContents = { setWindowOpenHandler() {} }; }
      loadURL() { loaded(); return Promise.resolve(); }
      on() {}
    },
    dialog: { showErrorBox(_title, message) { throw new Error(message); } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { openExternal() {} },
  };
  const stubs = {
    electron,
    fs: {
      readFileSync: () => JSON.stringify(state.config),
      mkdirSync() {},
      writeFileSync(_file, value) { state.config = JSON.parse(value); },
    },
    '../../runtime-cache': { clearRuntimeCache: () => 0 },
    child_process: {
      fork() {
        if (state.failNextFork) {
          state.failNextFork = false;
          throw new Error('backend could not start');
        }
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => {
          child.killed = true;
          if (state.autoExit) queueMicrotask(() => child.emit('exit', 0));
        };
        children.push(child);
        return child;
      },
    },
    net: {
      createServer: () => ({
        once() {},
        listen(_port, _host, callback) { callback(); },
        address: () => ({ port: 43123 }),
        close(callback) { callback(); },
      }),
    },
    http: {
      get(_options, callback) {
        queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
        return { on() { return this; }, destroy() {} };
      },
    },
  };
  const nodeRequire = Module.createRequire(mainPath);
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    console: { log() {}, error() {}, warn() {} },
    Promise, setTimeout, clearTimeout,
    process: { env: {}, platform: process.platform },
    __dirname: path.dirname(mainPath),
    require: (name) => Object.hasOwn(stubs, name) ? stubs[name] : nodeRequire(name),
  }, { filename: mainPath });
  await ready;
  return { state, children, listeners, save: (id) => handlers.get('settings:save')(null, id) };
}

test('concurrent desktop setting saves do not start two replacement backends', async () => {
  const desktop = await bootDesktop();
  const first = desktop.save('first');
  const second = await desktop.save('second');
  desktop.children[0].emit('exit', 0);
  assert.equal((await first).ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /正在保存/);
  assert.equal(desktop.state.config.jamendoClientId, 'first');
  assert.equal(desktop.children.filter((child) => !child.killed).length, 1);
  assert.equal(desktop.children.length, 2);
});

test('a failed desktop save rolls back before a new save can start', async () => {
  const desktop = await bootDesktop();
  desktop.state.failNextFork = true;
  const first = desktop.save('first');
  const second = await desktop.save('second');
  desktop.children[0].emit('exit', 0);
  assert.equal((await first).ok, false);
  assert.equal(second.ok, false);
  assert.equal(desktop.state.config.jamendoClientId, 'previous');
  assert.equal(desktop.children.filter((child) => !child.killed).length, 1);

  desktop.state.autoExit = true;
  assert.equal((await desktop.save('third')).ok, true);
  assert.equal(desktop.state.config.jamendoClientId, 'third');
  assert.equal(desktop.children.filter((child) => !child.killed).length, 1);
});

test('quitting during a desktop settings restart never launches another backend', async () => {
  const desktop = await bootDesktop();
  const pending = desktop.save('first');
  desktop.listeners.get('before-quit')({ preventDefault() {} });
  desktop.children[0].emit('exit', 0);
  assert.equal((await pending).ok, false);
  assert.equal(desktop.children.length, 1);
  assert.equal(desktop.state.config.jamendoClientId, 'previous');
  const afterQuit = await desktop.save('second');
  assert.equal(afterQuit.ok, false);
  assert.match(afterQuit.error, /退出/);
  assert.equal(desktop.children.length, 1);
});
