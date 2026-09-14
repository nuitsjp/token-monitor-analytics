import { createServer } from 'node:http';

function nextWindowBoundary(updatedAt, windowMinutes) {
  const time = Date.parse(updatedAt);
  const duration = windowMinutes * 60_000;
  return new Date((Math.floor(time / duration) + 1) * duration).toISOString();
}

function configuredReset(resetsAt, kind, windowMinutes, updatedAt) {
  if (typeof resetsAt === 'string') return resetsAt;
  if (resetsAt && typeof resetsAt === 'object') {
    return resetsAt[kind] ?? resetsAt[windowMinutes] ?? nextWindowBoundary(updatedAt, windowMinutes);
  }
  return nextWindowBoundary(updatedAt, windowMinutes);
}

export function makeSnapshot({
  value = 2.5,
  updatedAt = new Date().toISOString(),
  deviceCount = 2,
  resetsAt,
} = {}) {
  const period = (multiplier) => {
    const costUsd = value * multiplier;
    return {
      totalTokens: Math.round(value * 4000 * multiplier), costUsd,
      clientCosts: { codex: costUsd },
    };
  };
  const periods = () => ({ today: period(1), month: period(8), allTime: period(24) });
  const totals = periods();
  for (const aggregate of Object.values(totals)) {
    aggregate.totalTokens *= deviceCount;
    aggregate.costUsd *= deviceCount;
    aggregate.clientCosts.codex = aggregate.costUsd;
  }
  const provider = () => ({
    provider: 'codex', accountKey: 'mock-account', accountLabel: '開発用アカウント', planLabel: 'Mock plan',
    status: 'ok', source: 'mock', updatedAt,
    windows: [
      {
        kind: 'session', label: '5時間', limitId: 'codex', usedPercent: Math.min(90, value * 8),
        resetsAt: configuredReset(resetsAt, 'session', 300, updatedAt), windowMinutes: 300,
      },
      {
        kind: 'weekly', label: '1週間', limitId: 'codex', usedPercent: Math.min(95, value * 4),
        resetsAt: configuredReset(resetsAt, 'weekly', 10080, updatedAt), windowMinutes: 10080,
      },
    ],
  });
  return {
    type: 'stats', reason: 'mock', at: updatedAt,
    stats: {
      updatedAt, periods: totals, limits: { updatedAt, providers: [provider()] },
      devices: Array.from({ length: deviceCount }, (_, index) => ({
        deviceId: `device-${index + 1}`, hostname: index === 0 ? '開発用 Windows PC' : `開発用ノート ${index + 1}`, platform: 'win32',
        updatedAt, receivedAt: updatedAt, ageMs: 0, stale: false,
        clientHealth: {
          observedAt: updatedAt,
          clients: {
            codex: {
              overall: 'healthy',
              source: { state: 'detected' },
              collection: { state: 'direct' },
            },
          },
        },
        periods: periods(), limits: { updatedAt, refreshMs: 300000, providers: [provider()] },
      })),
    },
  };
}

function mockLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function makeHistoryDevices({ deviceCount = 2, historyMode = 'normal', historyDays = 5 } = {}) {
  const now = new Date();
  const todayKey = mockLocalDateKey(now);
  const devices = [];
  for (let index = 0; index < deviceCount; index++) {
    const daily = [];
    for (let back = historyDays; back >= 1; back--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const key = mockLocalDateKey(day);
      const cost = (index + 1) * back * 1.5;
      daily.push({
        date: key,
        tokens: Math.round(cost * 1000),
        cost,
        perClient: { codex: { tokens: Math.round(cost * 1000), cost } },
      });
    }
    // 当日分の未確定エントリ。U6の当日分除外により保存対象外となる。
    daily.push({
      date: todayKey,
      tokens: 10,
      cost: 0.01,
      perClient: { codex: { tokens: 10, cost: 0.01 } },
    });
    const months = new Map();
    for (const day of daily) {
      const month = day.date.slice(0, 7);
      const entry = months.get(month) ?? { month, tokens: 0, cost: 0, perClient: {} };
      entry.tokens += day.tokens;
      entry.cost += day.cost;
      const client = entry.perClient.codex ?? { tokens: 0, cost: 0 };
      client.tokens += day.perClient.codex.tokens;
      client.cost += day.perClient.codex.cost;
      entry.perClient.codex = client;
      months.set(month, entry);
    }
    const periodWindows = historyMode === 'missing-today'
      ? null
      : {
        today: { key: todayKey, endsAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString() },
        timeZone: historyMode === 'invalid-tz' ? 'Invalid/Zone' : 'Asia/Tokyo',
      };
    devices.push({
      deviceId: 'device-' + (index + 1),
      periodWindows,
      history: { daily, monthly: [...months.values()] },
    });
  }
  return devices;
}

export async function startMockHub({ host = '127.0.0.1', port = 8787, secret = 'mock-secret', automatic = true, scenario = 'normal', historyMode = 'normal', historyDelayMs = 0 } = {}) {
  let current = makeSnapshot();
  let sequence = 0;
  let requests = 0;
  const clients = new Set();
  const emit = (client, event, payload) => {
    try { client.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
    catch { clients.delete(client); client.destroy(); }
  };
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ runtime: 'mock', secretRequired: true }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return; }
    if (request.url === '/api/stats/stream') {
      requests++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(response);
      response.on('close', () => clients.delete(response));
      response.on('error', () => clients.delete(response));
      const initial = structuredClone(current);
      initial.at = initial.stats.updatedAt = new Date().toISOString();
      emit(response, 'snapshot', initial);
    } else if (request.url === '/api/devices' || request.url.startsWith('/api/devices?')) {
      requests++;
      const sendDevices = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ devices: makeHistoryDevices({ historyMode }) }));
      };
      if (historyDelayMs > 0) setTimeout(sendDevices, historyDelayMs);
      else sendDevices();
    } else { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  function broadcast(payload, event = 'stats') {
    current = structuredClone(payload);
    for (const client of clients) emit(client, event, current);
  }
  function disconnect() { for (const client of clients) client.end(); clients.clear(); }
  const tick = automatic ? setInterval(() => {
    sequence++;
    let payload;
    if (scenario === 'duplicate') {
      payload = structuredClone(current);
      payload.at = payload.stats.updatedAt = new Date().toISOString();
    } else {
      payload = makeSnapshot({ value: 2.5 + sequence * 0.1 });
      if (scenario === 'invalid' && sequence % 3 === 1) payload.stats.devices[1].periods.today.costUsd = 'invalid';
    }
    broadcast(payload);
    if (scenario === 'disconnect' && sequence % 3 === 0) disconnect();
  }, 5000) : null;
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': hb\n\n'); }, 30000);
  return {
    url: `http://${host}:${server.address().port}`, broadcast, disconnect,
    get requests() { return requests; },
    async close() { clearInterval(tick); clearInterval(heartbeat); disconnect(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); },
  };
}
