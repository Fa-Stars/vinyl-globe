'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

async function createPlayer({ songResponse, sessionResponse, demo = false, reducedMotion = false, playError, infoResponse, mapData, mapResponse, capitalsResponse, countryResponse, electronAPI, mediaSource, rangeResponse } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  let animationFrame;
  let renderedFrames = 0;
  let lastFrame = null;
  const schedule = (callback, ms, interval = false) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + ms, interval: interval ? ms : 0 });
    return id;
  };
  class Element extends EventTarget {
    constructor() {
      super();
      this.textContent = '';
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.href = '';
      this.value = '';
      this.type = 'text';
      this.style = { setProperty() {} };
      this.clientWidth = 320;
      this.clientHeight = 320;
      this.attributes = new Map();
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name),
      };
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'href') this.href = String(value);
      else if (name === 'hidden') this.hidden = true;
      else if (name === 'disabled') this.disabled = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'href') this.href = '';
      else if (name === 'hidden') this.hidden = false;
      else if (name === 'disabled') this.disabled = false;
    }
    focus() {}
    matches() { return false; }
    closest() { return null; }
    getContext() {
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(frame) { renderedFrames++; lastFrame = frame; },
      };
    }
    emit(type) { this.dispatchEvent(new Event(type)); }
  }
  class Audio extends Element {
    constructor() {
      super();
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.currentTime = 0;
      this.duration = 180;
      this.src = '';
    }
    load() { this.paused = true; this.ended = false; this.currentTime = 0; this.readyState = 0; }
    play() {
      if (playError) return Promise.reject(playError);
      this.paused = false;
      return Promise.resolve();
    }
    pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  }
  const elements = new Map([['audio', new Audio()]]);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const window = new Element();
  const beacons = [];
  const navigator = { onLine: true, sendBeacon: (url) => { beacons.push(url); return true; } };
  let songsRequested = 0;
  const requests = [];
  const fetches = [];
  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  const fetch = async (url, options = {}) => {
    fetches.push({ url, signal: options.signal, headers:options.headers, body:options.body, method:options.method });
    if (url === 'map.json' && mapResponse) return mapResponse(response, options.signal);
    if (url === 'map.json') return response(mapData || { w: 1, h: 1, grid: '..', names: {}, aliases: {} });
    if (url === 'capitals.json' && capitalsResponse) return capitalsResponse(response, options.signal);
    if (url === 'capitals.json') return response({});
    if (url === '/api/info') return infoResponse ? infoResponse(response, options.signal) : response({ mode: 'jamendo', configured: true });
    if (url === '/api/listening-session') return sessionResponse ? sessionResponse(options,response) : response({token:'test-session-token'});
    if (rangeResponse && url.startsWith('/audio/')) return rangeResponse(url, options);
    if (url.startsWith('/api/country?') && countryResponse) return countryResponse(url, options.signal, response);
    if (url === '/api/song') {
      const index = ++songsRequested;
      requests.push({ index, signal: options.signal, url });
      if (songResponse) return songResponse(index, options.signal, response);
      return response({
        id: String(index), title: 'Track ' + index, artist: 'Artist', artwork: '', duration: 180,
        streamUrl: '/audio/' + index, sourceUrl: 'https://www.jamendo.com/track/' + index,
        license: { name: 'CC BY-NC-SA 3.0', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' },
        countrycode: 'US', country: '美国',
      });
    }
    return response({});
  };
  class Image extends Element {
    set src(value) { this._src = String(value); }
    get src() { return this._src || ''; }
  }
  window.electronAPI = electronAPI;
  window.MediaSource = mediaSource;
  const motionPreference = new EventTarget();
  motionPreference.matches = reducedMotion;
  window.matchMedia = () => motionPreference;
  let reloads = 0;
  const location = { search: demo ? '?demo=1' : '', reload() { reloads++; } };
  window.location = location;
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element, activeElement: null },
    window, navigator, location,
    Image,
    console, fetch, URL: mediaSource?.URL || URL, MediaSource: mediaSource, URLSearchParams, AbortController, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: (id) => timers.delete(id),
    requestAnimationFrame(callback) { animationFrame = callback; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/public/app.js'), 'utf8'), context, { filename: 'app.js' });
  await flush();
  return {
    get reloads() { return reloads; },
    element, audio: element('audio'), requests, fetches, beacons,
    get songsRequested() { return songsRequested; },
    get playbackMode() { return element('np-mode').textContent; },
    frame(timestamp, hidden = false) {
      context.document.hidden = hidden;
      animationFrame(timestamp);
    },
    get renderedFrames() { return renderedFrames; },
    get lastFrame() {
      return lastFrame && { width: lastFrame.width, height: lastFrame.height, data: new Uint8ClampedArray(lastFrame.data) };
    },
    focusCountry(code, timestamp = 250) {
      if (!/^[A-Z]{2}$/.test(code)) throw new RangeError('Expected a two-letter country code');
      if (!Number.isFinite(timestamp)) throw new TypeError('Frame time must be finite');
      context.previewCountryCode = code;
      context.previewFrameTime = timestamp;
      try {
        return vm.runInContext(`(() => {
          setCountry(previewCountryCode);
          if (targetRot === null) return null;
          rot = targetRot; pitch = targetPitch; zoom = targetZoom;
          drawGlobe(previewFrameTime);
          return { code: highlightCode, rot, pitch, zoom, area: countryArea[highlightCode] || 0 };
        })()`, context);
      } finally {
        delete context.previewCountryCode;
        delete context.previewFrameTime;
      }
    },
    get globeRotation() { return vm.runInContext('rot', context); },
    async reduceMotion(enabled) {
      motionPreference.matches=enabled;
      const event=new Event('change');Object.defineProperty(event,'matches',{value:enabled});
      motionPreference.dispatchEvent(event);await flush();
    },
    get title() { return element('np-station').textContent; },
    get status() { return element('np-status').textContent; },
    async click(id) { element(id).emit('click'); await flush(); },
    async media(type) { element('audio').emit(type); await flush(); },
    async network(online) { navigator.onLine = online; window.emit(online ? 'online' : 'offline'); await flush(); },
    async pagehide(persisted=false) { const event=new Event('pagehide'); Object.defineProperty(event,'persisted',{value:persisted}); window.dispatchEvent(event); await flush(); },
    async tick(ms) {
      const until = now + ms;
      for (let count = 0; count < 100000; count++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = until; await flush(); return; }
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
        await flush();
      }
      throw new Error('Timer loop did not settle');
    },
    flush,
  };
}

module.exports = { createPlayer };
