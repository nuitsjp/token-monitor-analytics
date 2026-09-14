import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalyticsStore, validateHistoryQuery } from './store.js';
import { normalizeNotification, ValidationError } from './observations.js';
import { readEvents } from './sse.js';
import { HistoryValidationError, selectHistoryPayload } from './history.js';
import { validateHubRegistration } from './config.js';
import { appendHubRegistration } from './hub-registry.js';

const REGISTRATION_BODY_LIMIT = 4096;

// D-9: 管理操作は同一オリジンからのJSON POSTだけ受け付ける。
// Origin が無い要求（ブラウザー以外）は素通しし、Origin があるときだけ待受ホストと突き合わせる。
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers['sec-fetch-site'] === 'same-origin') return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REGISTRATION_BODY_LIMIT) throw new TypeError('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../public/index.html', import.meta.url)]],
  ['/app.js', ['text/javascript; charset=utf-8', new URL('../public/app.js', import.meta.url)]],
  ['/history.js', ['text/javascript; charset=utf-8', new URL('../public/history.js', import.meta.url)]],
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

export async function startAnalytics({ configuration, version = null, log = () => {}, reconnectMs = 3000, historyRetryMs = 3600000, historyPollMs = 60000, now = () => new Date() }) {
  const store = new AnalyticsStore(configuration.dbPath, {
    estimationSettings: configuration.estimation ?? {},
  });
  let saved;
  let persistedHistory;
  try {
    store.registerHubs(configuration.hubs.map((hub) => hub.id));
    saved = store.readState();
    persistedHistory = new Map(store.readHistoryFetchState().map((entry) => [entry.hubId, entry]));
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
      collectionStopped: !hub.collectionEnabled,
    }];
  }));
  const clients = new Map();
  const connections = [];
  const controller = new AbortController();
  let phase = 'running';
  let storage = { state: 'normal', message: null };
  let queue = Promise.resolve();
  let stopPromise;

  // U6: Hubごとの履歴取得制御。SSE受信・保存キューとは独立して通信待機し、
  // 保存だけを共通キューへ直列化する。generationで停止前後の遅着応答を破棄する。
  const historyControls = new Map();
  const hubStopFlags = new Map();
  const hubAborts = new Map();
  // Hubごとの収集ループの直列化。停止後に再開しても二重に収集しない。
  const hubLoops = new Map();
  const pendingStarts = new Set();

  function historyControl(hubId) {
    if (!historyControls.has(hubId)) {
      const persisted = persistedHistory.get(hubId);
      historyControls.set(hubId, {
        generation: 0, fetching: false, pending: null, abort: null, retryTimer: null,
        lastSuccess: persisted?.lastSuccessAt ?? null, devices: persisted?.devices ?? [],
        nextRetryAt: null, invalidDay: null, error: null,
      });
    }
    return historyControls.get(hubId);
  }
  function hubSignal(hubId) {
    if (!hubAborts.has(hubId)) hubAborts.set(hubId, new AbortController());
    return hubAborts.get(hubId).signal;
  }
  function hubEnabled(hubId) {
    return saved.hubs.find((hub) => hub.id === hubId)?.collectionEnabled === true
      && statuses.get(hubId)?.configuration === 'valid'
      && hubStopFlags.get(hubId) !== true;
  }
  function hostLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function historyState(hub) {
    const control = historyControl(hub.id);
    return {
      state: statuses.get(hub.id).collectionStopped ? 'stopped'
        : control.fetching ? 'fetching' : control.nextRetryAt ? 'retrying'
          : control.invalidDay ? 'invalid' : control.lastSuccess ? 'ready' : 'unfetched',
      lastSuccessAt: control.lastSuccess, nextRetryAt: control.nextRetryAt,
      error: control.error, devices: control.devices,
    };
  }

  function state() {
    return {
      phase, storage, mode: configuration.mode,
      // アプリの版と起動時に確認したスキーマ版。更新結果の提示に使う（UC-4）。
      runtime: { version, schemaVersion: store.schema.version, migratedFrom: store.schema.migratedFrom },
      features: { estimation: 'implemented', estimationHistory: 'implemented', history: 'implemented', hubManagement: 'implemented' },
      // 登録練習用のMock Hubは設定が持つときだけ返す。実データでは項目ごと出さない。
      ...(configuration.mockRegistration ? { mockRegistration: configuration.mockRegistration } : {}),
      contracts: saved.contracts, estimates: saved.estimates, metrics: saved.metrics, legacyEstimateCount: saved.legacyEstimateCount,
      hubs: saved.hubs.map((hub) => ({ ...hub, url: configured.get(hub.id)?.url ?? null, status: { ...statuses.get(hub.id) }, history: historyState(hub) })),
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
    for (const control of historyControls.values()) {
      clearHistoryRetry(control);
      control.abort?.abort();
    }
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

  function clearHistoryRetry(control) {
    if (control.retryTimer) clearTimeout(control.retryTimer);
    control.retryTimer = null;
    control.nextRetryAt = null;
  }

  function scheduleHistoryRetry(hub) {
    const control = historyControl(hub.id);
    clearHistoryRetry(control);
    control.nextRetryAt = new Date(now().getTime() + historyRetryMs).toISOString();
    control.retryTimer = setTimeout(() => {
      control.retryTimer = null;
      control.nextRetryAt = null;
      fetchHistory(hub, 'retry');
    }, historyRetryMs);
    control.retryTimer.unref();
  }

  // 全ての自動取得契機が同じ成功・再試行状態を参照する。
  function fetchHistory(hub, reason) {
    const control = historyControl(hub.id);
    if (phase !== 'running' || storage.state !== 'normal' || !hubEnabled(hub.id)) return Promise.resolve();
    if (control.fetching) return control.pending;
    const at = now();
    if (reason !== 'manual' && reason !== 'restart') {
      if (control.nextRetryAt) return Promise.resolve();
      if (control.invalidDay === hostLocalDateKey(at)) return Promise.resolve();
      if (reason === 'scheduled' || reason === 'reconnect') {
        const since = new Date(at.getFullYear(), at.getMonth(), at.getDate(), reason === 'scheduled' || at.getHours() >= 1 ? 1 : 0);
        if (at < since || (control.lastSuccess && new Date(control.lastSuccess) >= since)) return Promise.resolve();
      }
    }
    clearHistoryRetry(control);
    control.fetching = true;
    control.error = null;
    control.invalidDay = null;
    const generation = control.generation;
    const abort = new AbortController();
    control.abort = abort;
    control.pending = receiveHistory(hub, reason, control, generation, abort);
    return control.pending;
  }

  async function receiveHistory(hub, reason, control, generation, abort) {
    broadcast('status');
    const onGlobalAbort = () => abort.abort();
    controller.signal.addEventListener('abort', onGlobalAbort, { once: true });
    try {
      const response = await fetch(hub.url.replace(/\/$/, '') + '/api/devices', {
        headers: { Authorization: 'Bearer ' + hub.secret, Accept: 'application/json' },
        signal: abort.signal, redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('history request failed with HTTP ' + response.status);
      }
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) throw new HistoryValidationError('history JSON is invalid');
        throw error;
      }
      const fetchedAt = now().toISOString();
      const records = selectHistoryPayload(payload, fetchedAt);
      // 停止の採否は受信完了時点で固定する。受付済みの保存を後の停止で破棄しない。
      if (abort.signal.aborted || phase !== 'running' || control.generation !== generation || !hubEnabled(hub.id)) return;
      queue = queue.then(() => {
        if (storage.state !== 'normal') return;
        try { store.commitHistory(hub.id, records, fetchedAt); }
        catch (error) { stopSaving('failed', hub.id, error); return; }
        try { saved = store.readState(); }
        catch (error) { stopSaving('unreadable', hub.id, error); return; }
        control.lastSuccess = fetchedAt;
        control.devices = records.devices;
        control.invalidDay = null;
        control.error = null;
        clearHistoryRetry(control);
        broadcast('update');
      }).catch((error) => { stopSaving('failed', hub.id, error); });
      await queue;
    } catch (error) {
      if (abort.signal.aborted || controller.signal.aborted || control.generation !== generation) return;
      log({ level: 'error', operation: 'history-fetch', hubId: hub.id, reason, ...errorDetails(error) });
      if (error instanceof HistoryValidationError) {
        control.invalidDay = hostLocalDateKey(now());
        control.error = '履歴応答の形式が不正です。次回の定期取得を待ちます。';
      } else {
        control.error = '履歴の通信に失敗しました。';
        scheduleHistoryRetry(hub);
      }
    } finally {
      controller.signal.removeEventListener('abort', onGlobalAbort);
      control.abort = null;
      control.fetching = false;
      broadcast('status');
    }
  }

  function stopHubCollection(hubId) {
    if (!configured.has(hubId)) return Promise.resolve();
    const control = historyControl(hubId);
    control.generation += 1;
    control.abort?.abort();
    clearHistoryRetry(control);
    hubStopFlags.set(hubId, true);
    hubAborts.get(hubId)?.abort();
    queue = queue.then(() => {
      // 受信済み処理が終わった後に停止を表示する。設定保存の失敗とは独立する。
      statuses.get(hubId).collectionStopped = true;
      if (storage.state !== 'normal') { broadcast('status'); return; }
      try { store.setCollectionEnabled(hubId, false); }
      catch (error) { stopSaving('failed', hubId, error); return; }
      try { saved = store.readState(); }
      catch (error) { stopSaving('unreadable', hubId, error); return; }
      if (saveGap(hubId, 'collection_stopped', now().toISOString())) broadcast('status');
    }).catch((error) => { stopSaving('failed', hubId, error); });
    return queue;
  }

  function startHubCollection(hubId) {
    const hub = configured.get(hubId);
    if (!hub || hubEnabled(hubId)) return Promise.resolve();
    const control = historyControl(hubId);
    const generation = ++control.generation;
    const pending = resume();
    pendingStarts.add(pending);
    pending.finally(() => pendingStarts.delete(pending));
    return pending;

    async function resume() {
      // 旧通信の終了待ちは共通保存キューの外で行う。他Hubの受信・保存を止めない。
      await Promise.all([hubLoops.get(hubId), control.pending]);
      if (control.generation !== generation || phase !== 'running' || storage.state !== 'normal') return;
      queue = queue.then(() => {
        if (control.generation !== generation || phase !== 'running' || storage.state !== 'normal') return;
        try { store.setCollectionEnabled(hubId, true); }
        catch (error) { stopSaving('failed', hubId, error); return; }
        try { saved = store.readState(); }
        catch (error) { stopSaving('unreadable', hubId, error); return; }
        hubAborts.set(hubId, new AbortController());
        hubStopFlags.set(hubId, false);
        statuses.get(hubId).collectionStopped = false;
        broadcast('status');
        if (!hubEnabled(hubId)) return;
        const loop = collect(hub);
        connections.push(loop);
        hubLoops.set(hubId, loop);
        fetchHistory(hub, 'restart');
      }).catch((error) => { stopSaving('failed', hubId, error); });
      await queue;
    }
  }

  async function collect(hub) {
    const status = statuses.get(hub.id);
    const endpoint = `${hub.url.replace(/\/$/, '')}/api/stats/stream`;
    while (!controller.signal.aborted && hubStopFlags.get(hub.id) !== true) {
      status.connectionDetail = null;
      try {
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${hub.secret}`, Accept: 'text/event-stream' },
          signal: hubSignal(hub.id),
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
        fetchHistory(hub, 'reconnect');
        for await (const frame of readEvents(response.body)) {
          if (controller.signal.aborted || hubStopFlags.get(hub.id) === true) break;
          if (frame.event === 'snapshot' || frame.event === 'stats') accept(hub.id, frame.data, new Date().toISOString());
        }
      } catch (error) {
        if (!controller.signal.aborted && hubStopFlags.get(hub.id) !== true) log({ level: 'error', operation: 'hub-connection', hubId: hub.id, http: status.connectionDetail, ...errorDetails(error) });
      } finally {
        status.connection = 'disconnected';
        if (phase === 'running' && hubStopFlags.get(hub.id) !== true) {
          const at = new Date().toISOString();
          queue = queue.then(() => {
            if (storage.state === 'normal' && !saveGap(hub.id, 'disconnected', at)) return;
            broadcast('status');
          }).catch((error) => { stopSaving('failed', hub.id, error); });
        } else if (phase === 'running') {
          broadcast('status'); // 停止による切断も画面へ反映する（UC-2）
        }
      }
      if (hubStopFlags.get(hub.id) === true) break;
      if (!controller.signal.aborted) await delay(reconnectMs, undefined, { signal: hubSignal(hub.id) }).catch(() => {});
    }
  }

  // 起動時と同じ手順で収集を始める。collect()が遅延生成するコントローラを先に用意する。
  function beginCollecting(hub) {
    historyControl(hub.id);
    if (!hubAborts.has(hub.id)) hubAborts.set(hub.id, new AbortController());
    const loop = collect(hub);
    connections.push(loop);
    hubLoops.set(hub.id, loop);
    fetchHistory(hub, 'initial').catch(() => {});
  }

  // D-10: 登録は受信・保存と同じキューで直列化する。保存が成ってから収集を始める。
  function registerHub(input) {
    const done = queue.then(() => {
      const { hub, error } = validateHubRegistration(input);
      if (error) return { status: 400, body: { error } };
      if (configured.has(hub.id) || saved.hubs.some((row) => row.id === hub.id)) {
        return { status: 400, body: { error: 'hub_id_duplicate' } };
      }
      if (phase !== 'running' || storage.state !== 'normal') {
        log({ level: 'error', operation: 'register-hub', hubId: hub.id, reason: storage.message ?? '受付を停止しています。' });
        return { status: 500, body: { error: 'registration_failed' } };
      }
      try { appendHubRegistration(configuration.registryPath, hub); }
      catch (failure) {
        log({ level: 'error', operation: 'register-hub', hubId: hub.id, ...errorDetails(failure) });
        return { status: 500, body: { error: 'registration_failed' } };
      }
      try {
        store.registerHubs([hub.id]);
        saved = store.readState();
      } catch (failure) {
        stopSaving('failed', hub.id, failure);
        return { status: 500, body: { error: 'registration_failed' } };
      }
      statuses.set(hub.id, {
        configuration: 'valid', configurationError: null,
        connection: 'disconnected', connectionDetail: null, validationError: null,
        collectionStopped: false,
      });
      configured.set(hub.id, hub);
      beginCollecting(hub);
      log({ level: 'info', operation: 'register-hub', hubId: hub.id, url: hub.url });
      broadcast('status');
      return { status: 201, body: { id: hub.id, url: hub.url, status: { ...statuses.get(hub.id) } } };
    }).catch((failure) => {
      stopSaving('failed', null, failure);
      return { status: 500, body: { error: 'registration_failed' } };
    });
    queue = done.then(() => {});
    return done;
  }

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const path = request.url.split('?')[0];
    const controlRequest = request.method === 'POST' ? /^\/api\/hubs\/([^/]+)\/(stop|resume)$/.exec(path) : null;
    if (request.method === 'POST' && (path === '/api/hubs' || controlRequest)) {
      const respond = (code, body) => {
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };
      // D-9: 管理 API は JSON の POST だけを受け付け、同一オリジン検証を通す。
      const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') { respond(403, { error: 'unsupported_media_type' }); return; }
      if (!sameOrigin(request)) { respond(403, { error: 'origin_mismatch' }); return; }
      if (controlRequest) {
        let hubId = null;
        try { hubId = decodeURIComponent(controlRequest[1]); } catch { /* 不正なエンコードは未登録扱い */ }
        if (hubId === null || !configured.has(hubId) || !saved.hubs.some((hub) => hub.id === hubId)) {
          respond(404, { error: 'hub_not_found' });
          return;
        }
        // S5: 停止は保存失敗でも成立し、再開は保存が成ってから収集を始める。状態が確定してから応答する。
        const action = controlRequest[2];
        const applied = action === 'stop' ? stopHubCollection(hubId) : startHubCollection(hubId);
        applied.then(() => {
          log({ level: 'info', operation: `${action}-hub`, hubId });
          respond(200, { id: hubId, status: { ...statuses.get(hubId) }, storage: { ...storage } });
        });
        return;
      }
      readJsonBody(request)
        .then((body) => registerHub(body), () => ({ status: 400, body: { error: 'invalid_request' } }))
        .then(({ status, body }) => respond(status, body));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
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
      const respond = (code, body) => {
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
      };
      const params = new URL(request.url, 'http://localhost').searchParams;
      const options = {
        kind: params.get('kind') ?? 'daily',
        hubId: params.get('hubId') ?? undefined,
        deviceId: params.get('deviceId') ?? undefined,
        tool: params.get('tool') ?? undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        before: params.get('before') ?? undefined,
        limit: params.has('limit') ? Number(params.get('limit')) : 100,
      };
      try {
        if ([...params.keys()].some((name) => !['kind', 'hubId', 'deviceId', 'tool', 'from', 'to', 'limit', 'before'].includes(name) || params.getAll(name).length > 1)
          || ['hubId', 'deviceId', 'tool', 'from', 'to', 'before'].some((name) => params.has(name) && !params.get(name).trim())
          || (params.has('limit') && !/^\d+$/.test(params.get('limit')))) throw new TypeError('invalid history query');
        validateHistoryQuery(options);
      } catch {
        respond(400, { error: '履歴取得条件が不正です' });
        return;
      }
      if (storage.state === 'unreadable') {
        respond(503, { error: 'DB 参照不能のため取得できません' });
        return;
      }
      try { respond(200, store.readHistory(options)); }
      catch (error) {
        stopSaving('unreadable', null, error);
        respond(503, { error: 'DB 参照不能のため取得できません' });
      }
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
      const loop = collect(configured.get(savedHub.id));
      connections.push(loop);
      hubLoops.set(savedHub.id, loop);
    }
  }

  // U6: 初回接続時はSSEを直ちに開始し、履歴GETの完了を待たない（S2）。
  // 定期取得は稼働マシンの現地時刻で毎日午前1時にHubごとに取得する。
  for (const savedHub of saved.hubs) {
    if (savedHub.collectionEnabled && statuses.get(savedHub.id).configuration === 'valid') {
      historyControl(savedHub.id);
      // collect()がhubSignal()で遅延生成したコントローラを上書きしないこと。
      // 上書きすると停止時に古いシグナルが残り収集ループが終了しない。
      if (!hubAborts.has(savedHub.id)) hubAborts.set(savedHub.id, new AbortController());
      fetchHistory(configured.get(savedHub.id), 'initial').catch(() => {});
    }
  }
  const historyScheduler = setInterval(() => {
    if (phase !== 'running' || storage.state !== 'normal' || now().getHours() < 1) return;
    for (const hub of configured.values()) fetchHistory(hub, 'scheduled');
  }, historyPollMs);
  historyScheduler.unref();

  async function shutdown() {
    phase = 'stopping';
    controller.abort();
    clearInterval(historyScheduler);
    for (const control of historyControls.values()) {
      control.generation += 1;
      if (control.abort) control.abort.abort();
      clearHistoryRetry(control);
    }
    for (const abort of hubAborts.values()) {
      try { abort.abort(); } catch { /* ignore */ }
    }
    await Promise.all(connections);
    await Promise.all(pendingStarts);
    await Promise.all([...historyControls.values()].map((control) => control.pending));
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
    fetchHistory: (hubId, reason = 'manual') => {
      const hub = configured.get(hubId);
      if (!hub) return Promise.resolve();
      return fetchHistory(hub, reason);
    },
    stopHubCollection,
    startHubCollection,
  };
}
