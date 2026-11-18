'use strict';

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');
const { createJamendoAgent } = require('./jamendo-tls');

const TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'JAMENDO_HEADERS_TIMEOUT',
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const PREFERRED_TTL = 10 * 60 * 1000;
const MAX_DNS_CACHE = 32;

function hostnameOf(url) {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function supportedUrl(url) {
  const host = hostnameOf(url);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (host === 'api.jamendo.com' || host === 'usercontent.jamendo.com' || /^prod-\d+\.storage\.jamendo\.com$/.test(host));
}

function publicIPv4(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function dnsName(value) {
  if (typeof value !== 'string') return '';
  const name = value.toLowerCase().replace(/\.$/, '');
  return name.length <= 253 && name.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : '';
}

function dnsAddresses(result, host) {
  if (result.Status !== 0 || !Array.isArray(result.Answer)) throw new Error('Jamendo DNS has no usable answer');
  const visited = new Set();
  const ttlRecords = [];
  let owner = host;
  for (let depth = 0; depth < 8; depth++) {
    if (visited.has(owner)) throw new Error('Jamendo DNS alias cycle');
    visited.add(owner);
    const records = result.Answer.filter(item => dnsName(item.name) === owner);
    const aliases = records.filter(item => item.type === 5);
    if (aliases.length) {
      const targets = [...new Set(aliases.map(item => dnsName(item.data)))];
      if (targets.length !== 1 || !targets[0] || records.some(item => item.type === 1)) {
        throw new Error('Jamendo DNS alias is ambiguous');
      }
      ttlRecords.push(...aliases);
      owner = targets[0];
      continue;
    }
    const answers = records.filter(item => item.type === 1 && publicIPv4(item.data));
    const addresses = [...new Set(answers.map(item => item.data))].slice(0, 2);
    if (!addresses.length) throw new Error('Jamendo DNS has no public IPv4 answer');
    // An unrelated additional A record is not an answer for this host. Alias
    // lifetimes also bound the cache even when the terminal A has a longer TTL.
    ttlRecords.push(...answers);
    const ttl = Math.min(600, ...ttlRecords.map(item =>
      Number.isFinite(Number(item.TTL)) ? Math.max(0, Number(item.TTL)) : 0));
    return { addresses, ttl };
  }
  throw new Error('Jamendo DNS alias limit exceeded');
}

function errorChain(error, depth = 0) {
  if (!error || depth > 5) return [];
  return [error, ...errorChain(error.cause, depth + 1),
    ...(Array.isArray(error.errors) ? error.errors.flatMap(item => errorChain(item, depth + 1)) : [])];
}

function certificateFailure(error) {
  return errorChain(error).some(item =>
    /^(?:ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER))/.test(String(item.code || '')));
}

function transportFailure(error) {
  return !certificateFailure(error) && errorChain(error).some(item => TRANSPORT_CODES.has(item.code));
}

function abortReason(signal) {
  return signal.reason || new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function joinedSignal(first, second) {
  if (!first) return second;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  // Older Node 18 versions lack AbortSignal.any. Keep forwarding cancellation
  // after response headers too, because a caller can still cancel an audio body.
  const controller = new AbortController();
  for (const signal of [first, second]) {
    if (signal.aborted) controller.abort(abortReason(signal));
    else signal.addEventListener('abort', () => controller.abort(abortReason(signal)), { once: true });
  }
  return controller.signal;
}

function deadlineError() {
  const error = new Error('Jamendo response headers timed out');
  error.code = 'JAMENDO_HEADERS_TIMEOUT';
  return error;
}

function withCancellation(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function createJamendoFetch({
  fetchImpl = globalThis.fetch,
  requestImpl = https.request,
  now = Date.now,
  directTimeoutMs = 3000,
  dnsTimeoutMs = 5000,
  connectTimeoutMs = 8000,
  enabled = true,
} = {}) {
  const dnsCache = new Map();
  let preferredUntil = 0;

  async function directFetch(input, options, signal) {
    const controller = new AbortController();
    const activeSignal = joinedSignal(signal, controller.signal);
    const timer = setTimeout(() => controller.abort(deadlineError()), directTimeoutMs);
    let response;
    try {
      const pending = Promise.resolve().then(() => fetchImpl(input, { ...options, signal: activeSignal }));
      // A fetch implementation may resolve while cancellation is racing with
      // response headers. Close a late body instead of retaining its socket.
      pending.then(late => {
        if (activeSignal.aborted) {
          try { Promise.resolve(late.body?.cancel()).catch(() => {}); } catch { /* already locked or closed */ }
        }
      }, () => {});
      response = await withCancellation(pending, activeSignal);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function addressesFor(host, signal) {
    throwIfAborted(signal);
    const cached = dnsCache.get(host);
    if (cached && cached.expires > now()) return cached.addresses;
    dnsCache.delete(host);
    let lastError;
    for (const endpoint of RESOLVERS) {
      const controller = new AbortController();
      const activeSignal = joinedSignal(signal, controller.signal);
      const timer = setTimeout(() => controller.abort(new Error('Jamendo DNS lookup timed out')), dnsTimeoutMs);
      try {
        const query = new URL(endpoint);
        // DNS providers receive only the hostname, never the Jamendo API key.
        query.searchParams.set('name', host);
        query.searchParams.set('type', 'A');
        const lookup = (async () => {
          const response = await fetchImpl(query.href, {
            headers: { Accept: 'application/dns-json' }, signal: activeSignal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Jamendo DNS resolver unavailable');
          }
          return response.json();
        })();
        const result = await withCancellation(lookup, activeSignal);
        const { addresses, ttl } = dnsAddresses(result, host);
        if (ttl > 0) {
          if (dnsCache.size >= MAX_DNS_CACHE) dnsCache.delete(dnsCache.keys().next().value);
          dnsCache.set(host, { addresses, expires: now() + ttl * 1000 });
        }
        return addresses;
      } catch (error) {
        throwIfAborted(signal);
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    const error = new Error('Jamendo DNS lookup failed', { cause: lastError });
    error.code = 'JAMENDO_DNS_ERROR';
    throw error;
  }

  function requestAddress(url, method, headers, address, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let request;
      let incoming;
      let agent;
      const timer = setTimeout(() => request?.destroy(deadlineError()), connectTimeoutMs);
      try {
        const host = hostnameOf(url);
        const outgoingHeaders = Object.fromEntries(headers);
        outgoingHeaders.host = host;
        outgoingHeaders['accept-encoding'] = 'identity';
        const target = new URL(url.href);
        target.hostname = host;
        target.hash = '';
        agent = createJamendoAgent(address, { connectTimeoutMs });
        request = requestImpl(target, {
          protocol: 'https:', hostname: host, servername: host, port: 443,
          path: url.pathname + url.search, method, headers: outgoingHeaders,
          agent, signal,
          // Resolve just this request while retaining certificate-chain and
          // hostname validation, including when TLS is weakened externally.
          rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
          lookup(_hostname, lookupOptions, callback) {
            if (lookupOptions?.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
        }, response => {
          incoming = response;
          incoming.once('close', () => agent.destroy());
          clearTimeout(timer);
          resolve(response);
        });
        request.once('error', error => {
          clearTimeout(timer);
          if (incoming && !incoming.complete) incoming.destroy(error);
          agent.destroy();
          reject(error);
        });
        request.end();
      } catch (error) {
        clearTimeout(timer);
        request?.destroy();
        agent?.destroy();
        reject(error);
      }
    });
  }

  function responseFrom(incoming, method) {
    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
    }
    const status = incoming.statusCode;
    if (method === 'HEAD' || status === 204 || status === 205 || status === 304) {
      incoming.destroy();
      return new Response(null, { status, headers });
    }
    let body = incoming;
    const encoding = (headers.get('content-encoding') || '').toLowerCase().trim();
    if (encoding && encoding !== 'identity') {
      // A byte-range response must retain the byte representation described by
      // Content-Range. Ordinary JSON responses can safely be decompressed.
      const decode = encoding === 'gzip' ? zlib.createGunzip : encoding === 'deflate' ? zlib.createInflate :
        encoding === 'br' ? zlib.createBrotliDecompress : null;
      if (!decode || status === 206) {
        incoming.destroy();
        throw new Error('Unsupported Jamendo response encoding');
      }
      body = decode();
      incoming.once('error', error => body.destroy(error));
      body.once('error', () => incoming.destroy());
      body.once('close', () => { if (!incoming.complete) incoming.destroy(); });
      incoming.pipe(body);
      headers.delete('content-encoding');
      headers.delete('content-length');
    }
    const stream = Readable.toWeb(body, {
      strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
    });
    return new Response(stream, { status, headers });
  }

  async function fallbackFetch(initialUrl, method, originalHeaders, signal) {
    let url = initialUrl;
    const headers = new Headers(originalHeaders);
    for (let redirects = 0; redirects <= 3; redirects++) {
      throwIfAborted(signal);
      const addresses = await addressesFor(hostnameOf(url), signal);
      let incoming;
      let lastError;
      for (const address of addresses) {
        try {
          incoming = await requestAddress(url, method, headers, address, signal);
          break;
        } catch (error) {
          throwIfAborted(signal);
          if (!transportFailure(error)) throw error;
          lastError = error;
        }
      }
      if (!incoming) throw new Error('Jamendo connection failed', { cause: lastError });
      if (REDIRECTS.has(incoming.statusCode) && incoming.headers.location) {
        incoming.destroy();
        const next = new URL(incoming.headers.location, url);
        if (redirects === 3 || !supportedUrl(next)) throw new Error('Jamendo redirect is not supported');
        if (hostnameOf(next) !== hostnameOf(url)) {
          headers.delete('authorization');
          headers.delete('cookie');
        }
        url = next;
        continue;
      }
      const result = responseFrom(incoming, method);
      preferredUntil = now() + PREFERRED_TTL;
      return result;
    }
    throw new Error('Jamendo redirect limit exceeded');
  }

  return async function jamendoFetch(input, options = {}) {
    let url;
    try { url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url); }
    catch { return fetchImpl(input, options); }
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (!enabled || !supportedUrl(url) || !['GET', 'HEAD'].includes(method)) return fetchImpl(input, options);
    const signal = options.signal || input?.signal;
    throwIfAborted(signal);
    const headers = options.headers ?? input?.headers;
    if (preferredUntil > now()) {
      try { return await fallbackFetch(url, method, headers, signal); }
      catch (error) {
        throwIfAborted(signal);
        if (certificateFailure(error) || (!transportFailure(error) && error.code !== 'JAMENDO_DNS_ERROR')) throw error;
        preferredUntil = 0;
        // A changed network can make the ordinary route usable again.
        return directFetch(input, options, signal);
      }
    }
    try {
      return await directFetch(input, options, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (!transportFailure(error)) throw error;
      return fallbackFetch(url, method, headers, signal);
    }
  };
}

module.exports = { createJamendoFetch };
