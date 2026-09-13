import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalyticsStore } from './store.js';
import { normalizeNotification, ValidationError } from './observations.js';
import { readEvents } from './sse.js';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../public/index.html', import.meta.url)]],
  ['/app.js', ['text/javascript; charset=utf-8', new URL('../public/app.js', import.meta.url)]],
  ['/style.css', ['text/css; charset=utf-8', new URL('../public/style.css', import.meta.url)]],
  ['/favicon.svg', ['image/svg+xml', new URL('../public/favicon.svg', import.meta.url)]],
]);

function errorDetails(error) {
  const causeCode = error?.code ?? error?.cause?.code;
  const code = typeof causeCode === 'string' && /^[A-Z0-9_]+$/.test(causeCode) ? causeCode : null;
  return {
    code,
    ...(Number.isInteger(error?.errcode) ? { sqliteCode: error.errcode } : {}),
    category: error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError' : 'Error',
  };
}

export async function startAnalytics({ configuration, log = () => {}, reconnectMs = 3000 }) {
  const store = new AnalyticsStore(configuration.dbPath, {
    estimationSettings: configuration.estimation ?? {},
  });
  let saved;
  try {
    store.registerHubs(configuration.hubs.map((hub) => hub.id));
    saved = store.readState();
  } catch (error) {
    store.close();
    throw error;
  }
  const configured = new Map(configuration.hubs.map((hub) => [hub.id, hub]));
  const statuses = new Map(saved.hubs.map((hub) => {
    const input = configured.get(hub.id);
    return [hub.id, {
      configuration: !input ? 'missing' : input.configError ? 'invalid' : 'valid',
      configurationError: input?.configError ?? null,
      connection: 'disconnected', connectionDetail: null, validationError: null,
    }];
  }));
  const clients = new Map();
  const connections = [];
  const controller = new AbortController();
  let phase = 'running';
  let storage = { state: 'normal', message: null };
  let queue = Promise.resolve();
  let stopPromise;

  function state() {
    return {
      phase, storage, mode: configuration.mode,
      features: { estimation: 'implemented', estimationHistory: 'implemented', history: 'unimplemented', hubManagement: 'unimplemented' },
      contracts: saved.contracts, estimates: saved.estimates, metrics: saved.metrics, legacyEstimateCount: saved.legacyEstimateCount,
      hubs: saved.hubs.map((hub) => ({ ...hub, status: { ...statuses.get(hub.id) } })),
    };
  }

  function send(response, event, current) {
    const client = clients.get(response);
    if (!client) return;
    if (client.blocked) { client.pending = event; return; }
    try {
      if (response.destroyed) {
        clients.delete(response);
        return;
      }
      // false means buffered, not failed. Wait for drain before sending another full state.
      client.blocked = !response.write(`event: ${event}\ndata: ${JSON.stringify(current)}\n\n`);
    } catch {
      clients.delete(response);
      response.destroy();
    }
  }

  function broadcast(event) {
    const current = state();
    for (const client of clients.keys()) send(client, event, current);
  }

  function stopSaving(kind, hubId, error) {
    storage = {
      state: kind,
      message: kind === 'unreadable' ? '更新停止・DB 参照不能' : '保存失敗',
    };
    log({ level: 'error', operation: kind === 'unreadable' ? 'read-state' : 'save-notification', hubId, ...errorDetails(error) });
    broadcast('status');
  }

  function accept(hubId, data, receivedAt) {
    if (phase !== 'running' || storage.state !== 'normal') return;
    queue = queue.then(() => {
      if (storage.state !== 'normal') return;
      let normalized;
      try {
        let payload;
        try { payload = JSON.parse(data); }
        catch { throw new ValidationError('SSE 通知の JSON 書式が不正です'); }
        normalized = normalizeNotification(payload);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        statuses.get(hubId).validationError = error.message;
        log({ level: 'error', operation: 'validate-notification', hubId, reason: error.message });
        if (!saveGap(hubId, 'invalid_notification', receivedAt)) return;
        broadcast('status');
        return;
      }
      try { store.commitNotification(hubId, normalized, receivedAt); }
      catch (error) { stopSaving('failed', hubId, error); return; }

      // A read failure after COMMIT must never enter the rollback path.
      try { saved = store.readState(); }
      catch (error) { stopSaving('unreadable', hubId, error); return; }
      statuses.get(hubId).validationError = null;
      broadcast('update');
    }).catch((error) => { stopSaving('failed', hubId, error); });
  }

  function saveGap(hubId, reason, at) {
    try { store.markEstimationGap(hubId, reason, at); }
    catch (error) { stopSaving('failed', hubId, error); return false; }
    try { saved = store.readState(); }
    catch (error) { stopSaving('unreadable', hubId, error); return false; }
    return true;
  }

  async function collect(hub) {
    const status = statuses.get(hub.id);
    const endpoint = `${hub.url.replace(/\/$/, '')}/api/stats/stream`;
    while (!controller.signal.aborted) {
      status.connectionDetail = null;
      try {
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${hub.secret}`, Accept: 'text/event-stream' },
          signal: controller.signal,
          redirect: 'manual',
        });
        if (!response.ok) {
          await response.body?.cancel();
          status.connectionDetail = `HTTP ${response.status}`;
          throw new Error('Hub response was not successful');
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          await response.body?.cancel();
          status.connectionDetail = 'SSE 応答ではありません';
          throw new Error('Unexpected content type');
        }
        status.connection = 'connected';
        status.connectionDetail = null;
        broadcast('status');
        for await (const frame of readEvents(response.body)) {
          if (controller.signal.aborted) break;
          if (frame.event === 'snapshot' || frame.event === 'stats') accept(hub.id, frame.data, new Date().toISOString());
        }
      } catch (error) {
        if (!controller.signal.aborted) log({ level: 'error', operation: 'hub-connection', hubId: hub.id, http: status.connectionDetail, ...errorDetails(error) });
      } finally {
        status.connection = 'disconnected';
        if (phase === 'running') {
          const at = new Date().toISOString();
          queue = queue.then(() => {
            if (storage.state === 'normal' && !saveGap(hub.id, 'disconnected', at)) return;
            broadcast('status');
          }).catch((error) => { stopSaving('failed', hub.id, error); });
        }
      }
      if (!controller.signal.aborted) await delay(reconnectMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  }

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = request.url.split('?')[0];
    if (path === '/api/state') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(state()));
    } else if (path === '/api/events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      response.on('close', () => clients.delete(response));
      response.on('error', () => clients.delete(response));
      // Registration and first state are synchronous, so no update can fall between them.
      clients.set(response, { blocked: false, pending: null });
      response.on('drain', () => {
        const client = clients.get(response);
        if (!client) return;
        client.blocked = false;
        const pending = client.pending;
        client.pending = null;
        if (pending) send(response, pending, state());
      });
      send(response, 'status', state());
    } else if (path === '/api/estimates/history') {
      const respond = (code, body) => {
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
      };
      const params = new URL(request.url, 'http://localhost').searchParams;
      const positive = (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
      const invalid = [...params.keys()].some((name) => !['scope', 'hubId', 'seriesId', 'before', 'limit'].includes(name) || params.getAll(name).length > 1)
        || (params.has('scope') && !['global', 'legacy'].includes(params.get('scope')))
        || ['hubId', 'seriesId'].some((name) => params.has(name) && !params.get(name).trim())
        || ['before', 'limit'].some((name) => params.has(name) && !positive(params.get(name)));
      if (invalid) { respond(400, { error: '履歴取得条件が不正です' }); return; }
      if (storage.state === 'unreadable') { respond(503, { error: 'DB 参照不能のため取得できません' }); return; }
      try {
        respond(200, store.readEstimationHistory({
          hubId: params.get('hubId') ?? undefined, seriesId: params.get('seriesId') ?? undefined,
          beforeId: params.has('before') ? Number(params.get('before')) : undefined,
          limit: params.has('limit') ? Number(params.get('limit')) : 50,
          scope: params.get('scope') ?? 'global',
        }));
      } catch (error) {
        stopSaving('unreadable', null, error);
        respond(503, { error: 'DB 参照不能のため取得できません' });
      }
    } else if (path === '/api/history') {
      response.writeHead(storage.state === 'unreadable' ? 503 : 501, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: storage.state === 'unreadable' ? 'DB 参照不能のため取得できません' : '履歴機能は未実装です' }));
    } else if (assets.has(path)) {
      const [type, filename] = assets.get(path);
      response.writeHead(200, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : readFileSync(filename));
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(configuration.port, configuration.host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  try {
    store.beginCollection(new Date().toISOString());
    for (const hub of saved.hubs) {
      if (!hub.collectionEnabled || statuses.get(hub.id).configuration !== 'valid') {
        store.markEstimationGap(hub.id, 'disconnected', new Date().toISOString());
      }
    }
    saved = store.readState();
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    throw error;
  }
  for (const savedHub of saved.hubs) {
    if (savedHub.collectionEnabled && statuses.get(savedHub.id).configuration === 'valid') {
      connections.push(collect(configured.get(savedHub.id)));
    }
  }

  async function shutdown() {
    phase = 'stopping';
    controller.abort();
    await Promise.all(connections);
    await queue;
    broadcast('status');
    for (const client of clients.keys()) client.end();
    clients.clear();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    try { if (storage.state === 'normal') store.finishCollection(); }
    finally { store.close(); }
  }
  return {
    server, store, state, drain: () => queue,
    stop: () => { stopPromise ??= shutdown(); return stopPromise; },
    address: server.address(),
  };
}
