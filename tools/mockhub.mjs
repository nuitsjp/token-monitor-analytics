import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const MOCK_HUB_SECRET = 'demo-hub-secret';
export const DEFAULT_LISTEN = '127.0.0.1:8765';
export const DEFAULT_INTERVAL_MS = 3000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function revision(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function dayKey(ms) {
  return iso(ms).slice(0, 10);
}

function monthKey(ms) {
  return iso(ms).slice(0, 7);
}

function nextDay(ms) {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function nextMonth(ms) {
  const date = new Date(ms);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

function periodWindows(ms) {
  return {
    timeZone: 'UTC',
    today: {key: dayKey(ms), endsAt: nextDay(ms)},
    month: {key: monthKey(ms), endsAt: nextMonth(ms)},
  };
}

function historyRow(date, tokens, cost, messages) {
  return {
    date,
    tokens,
    cost,
    messages,
    cacheReadTokens: Math.floor(tokens / 2),
    cacheWriteTokens: 0,
    outputTokens: Math.floor(tokens / 4),
    tokenComponentsAvailable: true,
    perClient: {claude: {tokens, cost, messages}},
  };
}

function defaultHistory(ms) {
  const today = dayKey(ms);
  const previous = dayKey(ms - 24 * 60 * 60 * 1000);
  const monthlyTokens = monthKey(ms) === monthKey(ms - 24 * 60 * 60 * 1000) ? 3600 : 2400;
  const monthlyCost = monthlyTokens / 1000;
  const monthlyMessages = monthlyTokens / 100;
  return {
    daily: [
      historyRow(previous, 1200, 1.2, 12),
      historyRow(today, 2400, 2.4, 24),
    ],
    monthly: [{
      month: monthKey(ms),
      tokens: monthlyTokens,
      cost: monthlyCost,
      messages: monthlyMessages,
      tokenComponentsAvailable: true,
      perClient: {claude: {tokens: monthlyTokens, cost: monthlyCost, messages: monthlyMessages}},
    }],
    summary: {totalTokens: 3600, totalCost: 3.6, activeDays: 2},
  };
}

function defaultDevice(ms, history = defaultHistory(ms)) {
  const at = iso(ms);
  const monthly = history?.monthly?.find(row => row.month === monthKey(ms));
  const summary = history?.summary ?? {};
  return {
    deviceId: 'demo-pc',
    hostname: 'demo-pc',
    platform: 'linux-x64',
    agentVersion: 'mockhub',
    updatedAt: at,
    stale: false,
    today: {totalTokens: 2400, costUsd: 2.4},
    month: {totalTokens: monthly?.tokens ?? 3600, costUsd: monthly?.cost ?? 3.6},
    allTime: {totalTokens: summary.totalTokens ?? 3600, costUsd: summary.totalCost ?? 3.6},
    periodWindows: periodWindows(ms),
    historyAvailable: true,
    history,
  };
}

function splitListen(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('mock Hub listen address is required');
  const input = value.trim();
  let host;
  let portText;
  if (input.startsWith('[')) {
    const close = input.indexOf(']');
    if (close < 0 || input[close + 1] !== ':') throw new Error('mock Hub listen address must be host:port');
    host = input.slice(1, close);
    portText = input.slice(close + 2);
  } else {
    const separator = input.lastIndexOf(':');
    if (separator <= 0) throw new Error('mock Hub listen address must be host:port');
    host = input.slice(0, separator);
    portText = input.slice(separator + 1);
  }
  const port = Number(portText);
  if (!net.isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('mock Hub listen address must contain a valid IP and port');
  }
  const loopback = host === '::1' || host === '127.0.0.1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (!loopback) throw new Error('mock Hub must bind a loopback IP');
  return {host, port};
}

function addressText(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function authFailure(response) {
  response.statusCode = 401;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end('unauthorized\n');
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', Buffer.byteLength(text));
  response.end(text);
}

function deviceRevisionEntries(devices) {
  return devices.map(device => {
    const hasHistory = Object.hasOwn(device, 'history');
    const hasAvailability = Object.hasOwn(device, 'historyAvailable');
    return {
      deviceId: String(device.deviceId || '').trim(),
      historyAvailable: hasAvailability ? device.historyAvailable === true : 'missing',
      history: !hasHistory ? 'missing' : device.history === null ? 'unavailable' : revision(device.history),
    };
  }).filter(entry => entry.deviceId).sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function historyRevisionEntries(devices) {
  return devices.map(device => ({
    deviceId: String(device.deviceId || '').trim(),
    history: Object.hasOwn(device, 'history') ? device.history : 'missing',
  })).filter(entry => entry.deviceId).sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function deriveRevisions(devices) {
  return {
    historyRevision: revision(historyRevisionEntries(devices)),
    deviceHistoryRevision: revision(deviceRevisionEntries(devices)),
  };
}

function statsDevice(device, at, fallbackPeriod) {
  const allTime = device.statsAllTime ?? fallbackPeriod;
  return {
    deviceId: String(device.deviceId),
    updatedAt: at,
    stale: typeof device.stale === 'boolean' ? device.stale : false,
    periods: {allTime: clone(allTime)},
  };
}

function parseRevision(value, name) {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`${name} must be a non-empty string of at most 256 characters`);
  return value;
}

function makeState(options, startedAt) {
  const devices = options.devices === undefined
    ? [defaultDevice(startedAt, options.history === undefined ? defaultHistory(startedAt) : clone(options.history))]
    : clone(options.devices);
  if (!Array.isArray(devices)) throw new Error('mock Hub devices must be an array');
  const derived = deriveRevisions(devices);
  return {
    startedAt,
    devices,
    historyRevision: options.historyRevision === undefined ? derived.historyRevision : parseRevision(options.historyRevision, 'historyRevision'),
    deviceHistoryRevision: options.deviceHistoryRevision === undefined ? derived.deviceHistoryRevision : parseRevision(options.deviceHistoryRevision, 'deviceHistoryRevision'),
  };
}

function makeStats(state, now, tick) {
  const at = iso(now);
  const cost = 100 + tick * 8;
  const tokens = 10000 + tick * 500;
  const allTime = {costUsd: cost, totalTokens: tokens, clientCosts: {claude: cost}};
  const stats = {
    type: 'stats',
    at,
    stats: {
      updatedAt: at,
      periods: {today: allTime, month: allTime, allTime},
      devices: state.devices.map(device => statsDevice(device, at, allTime)),
      limits: {
        providers: [{
          provider: 'claude',
          accountKey: 'demo-account',
          status: 'ok',
          stale: false,
          updatedAt: at,
          windows: [{kind: 'weekly', usedPercent: (tick % 18) * 5, resetsAt: iso(state.startedAt + (Math.floor(tick / 18) + 1) * 7 * 24 * 60 * 60 * 1000)}],
        }],
      },
    },
  };
  if (state.historyRevision !== null && state.historyRevision !== undefined) stats.stats.historyRevision = state.historyRevision;
  if (state.deviceHistoryRevision !== null && state.deviceHistoryRevision !== undefined) stats.stats.deviceHistoryRevision = state.deviceHistoryRevision;
  return stats;
}

export function createMockHub(options = {}) {
  const listen = splitListen(options.listen ?? DEFAULT_LISTEN);
  const disconnectAfter = options.disconnectAfter ?? options['disconnect-after'] ?? 0;
  if (!Number.isInteger(disconnectAfter) || disconnectAfter < 0) throw new Error('disconnect-after must be a non-negative integer');
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('mock Hub interval must be positive');
  const secret = options.secret ?? MOCK_HUB_SECRET;
  if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret)) throw new Error('mock Hub secret must be a non-empty single-line string');
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new Error('mock Hub clock must be a function');
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) throw new Error('mock Hub clock must return a finite timestamp');
  const state = makeState(options, startedAt);
  const streams = new Set();

  const authorized = request => request.headers.authorization === `Bearer ${secret}`;

  function writeStreamFrame(stream) {
    if (stream.response.destroyed || stream.response.writableEnded) return false;
    const eventName = stream.frames === 0 ? 'snapshot' : 'stats';
    const now = Number(clock());
    const tick = Math.max(0, Math.floor((now - state.startedAt) / DEFAULT_INTERVAL_MS));
    const payload = JSON.stringify(makeStats(state, now, tick));
    stream.response.write(`event: ${eventName}\ndata: ${payload}\n\n`);
    stream.frames += 1;
    if (disconnectAfter > 0 && stream.frames >= disconnectAfter) {
      stream.response.end();
      return false;
    }
    return true;
  }

  function closeStream(stream) {
    if (!streams.delete(stream)) return;
    clearInterval(stream.timer);
    if (!stream.response.writableEnded && !stream.response.destroyed) stream.response.end();
  }

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://mockhub.invalid');
    if (requestUrl.pathname === '/api/health') {
      sendJson(response, 200, {ok: true, synthetic: true});
      return;
    }
    if (requestUrl.pathname === '/api/stats/stream') {
      if (!authorized(request)) {
        authFailure(response);
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, {error: 'method_not_allowed'});
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      const stream = {response, frames: 0, timer: null};
      streams.add(stream);
      request.once('close', () => closeStream(stream));
      if (!writeStreamFrame(stream)) closeStream(stream);
      else {
        stream.timer = setInterval(() => {
          if (!writeStreamFrame(stream)) closeStream(stream);
        }, intervalMs);
        stream.timer.unref?.();
      }
      return;
    }
    if (requestUrl.pathname === '/api/devices') {
      if (!authorized(request)) {
        authFailure(response);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, {error: 'method_not_allowed'});
        return;
      }
      const body = JSON.stringify({devices: clone(state.devices)});
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', Buffer.byteLength(body));
      if (request.method === 'HEAD') response.end();
      else response.end(body);
      return;
    }
    response.statusCode = 404;
    response.end('not found\n');
  });
  server.headersTimeout = 5_000;

  const hub = {
    server,
    secret,
    listen,
    get devices() { return clone(state.devices); },
    get revisions() { return {historyRevision: state.historyRevision, deviceHistoryRevision: state.deviceHistoryRevision}; },
    get origin() {
      const address = server.address();
      if (!address || typeof address === 'string') return null;
      return `http://${addressText(address.address, address.port)}`;
    },
    setDevices(devices, revisions = {}) {
      if (!Array.isArray(devices)) throw new Error('mock Hub devices must be an array');
      state.devices = clone(devices);
      const derived = deriveRevisions(state.devices);
      state.historyRevision = revisions.historyRevision === undefined ? derived.historyRevision : parseRevision(revisions.historyRevision, 'historyRevision');
      state.deviceHistoryRevision = revisions.deviceHistoryRevision === undefined ? derived.deviceHistoryRevision : parseRevision(revisions.deviceHistoryRevision, 'deviceHistoryRevision');
    },
    setDeviceHistory(deviceId, history, fields = {}) {
      const device = state.devices.find(entry => entry?.deviceId === deviceId);
      if (!device) throw new Error(`unknown mock Hub device: ${deviceId}`);
      if (history === undefined) delete device.history;
      else device.history = clone(history);
      if (Object.hasOwn(fields, 'historyAvailable')) device.historyAvailable = fields.historyAvailable;
      if (Object.hasOwn(fields, 'periodWindows')) device.periodWindows = clone(fields.periodWindows);
      if (Object.hasOwn(fields, 'updatedAt')) device.updatedAt = fields.updatedAt;
      const derived = deriveRevisions(state.devices);
      state.historyRevision = fields.historyRevision === undefined ? derived.historyRevision : parseRevision(fields.historyRevision, 'historyRevision');
      state.deviceHistoryRevision = fields.deviceHistoryRevision === undefined ? derived.deviceHistoryRevision : parseRevision(fields.deviceHistoryRevision, 'deviceHistoryRevision');
    },
    setRevisions(revisions = {}) {
      if (Object.hasOwn(revisions, 'historyRevision')) state.historyRevision = parseRevision(revisions.historyRevision, 'historyRevision');
      if (Object.hasOwn(revisions, 'deviceHistoryRevision')) state.deviceHistoryRevision = parseRevision(revisions.deviceHistoryRevision, 'deviceHistoryRevision');
    },
    async start() {
      if (server.listening) return hub;
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(listen.port, listen.host);
      });
      return hub;
    },
    async close() {
      for (const stream of [...streams]) closeStream(stream);
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  return hub;
}

export async function startMockHub(options = {}) {
  const hub = createMockHub(options);
  await hub.start();
  return hub;
}

export function parseMockHubArgs(argv = process.argv.slice(2)) {
  const options = {listen: DEFAULT_LISTEN, disconnectAfter: 0};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') return {help: true, ...options};
    const match = /^(--?|)(listen|disconnect-after)(?:=(.*))?$/.exec(argument);
    if (!match || !match[1]) throw new Error(`unknown option: ${argument}`);
    let value = match[3];
    if (value === undefined) {
      value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${argument}`);
    }
    if (match[2] === 'listen') options.listen = value;
    else {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error('disconnect-after must be a non-negative integer');
      options.disconnectAfter = parsed;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseMockHubArgs(argv);
  if (options.help) {
    console.log('Usage: node tools/mockhub.mjs [-listen HOST:PORT] [-disconnect-after N]');
    return null;
  }
  const hub = await startMockHub(options);
  const address = hub.server.address();
  const text = address && typeof address !== 'string' ? addressText(address.address, address.port) : String(address);
  console.error(`synthetic Hub at http://${text} (secret: ${MOCK_HUB_SECRET})`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await hub.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return hub;
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
