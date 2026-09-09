import {validateHubUrl, isSafeId} from '../src/hubs.ts';
import {
  listHubRecords, getHubRecord, countNonArchivedHubs, insertHub,
  updateHubRecord, archiveHubRecord, readHubSecretStore, readHubSecret,
  writeHubSecret,
} from './hubs.mjs';
import {canView, allowedRequest} from './auth.mjs';

const MAX_HUB_LABEL = 128;
const MAX_HUBS = 8;
const PUBLIC_ERROR_CODES = new Set([
  'origin_rejected', 'viewer_auth_required', 'origin_required', 'method_not_allowed',
  'json_required', 'invalid_json', 'body_too_large', 'invalid_hub_id', 'invalid_label',
  'invalid_url', 'invalid_secret', 'hub_id_exists', 'hub_limit', 'hub_url_exists',
  'save_failed', 'hub_not_found', 'expected_version_required', 'invalid_status',
  'version_conflict', 'hub_referenced_by_contract', 'delete_failed', 'update_failed',
  'update_manager_unavailable', 'check_failed', 'apply_failed', 'not_found',
  'secret_store_missing', 'secret_store_invalid', 'missing_secret',
  'history_not_ready', 'history_unavailable',
]);
const PUBLIC_CONNECTION_CODES = new Set([
  'network_error', 'auth_error', 'input_error', 'config_error', 'storage_error', 'permanent_error', 'missing_secret',
]);

function errorWithStatus(message, status, code) {
  return Object.assign(new Error(message), {status, code});
}

function publicErrorCode(error, fallback) {
  return typeof error?.code === 'string' && PUBLIC_ERROR_CODES.has(error.code)
    ? error.code
    : fallback;
}

function publicCurrentVersion(error) {
  return Number.isSafeInteger(error?.currentVersion) && error.currentVersion >= 1
    ? error.currentVersion
    : undefined;
}

function publicHttpStatus(error, fallback) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : fallback;
}

function decodeHubId(value) {
  try { return decodeURIComponent(value); }
  catch { throw errorWithStatus('Invalid Hub ID', 400, 'invalid_hub_id'); }
}

function expectedVersion(body, url) {
  const value = body?.expectedVersion ?? url?.searchParams.get('expectedVersion');
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

function validateSecret(secret, auth, config, {required = false} = {}) {
  if (secret === undefined || secret === '') {
    if (required) throw errorWithStatus('Hub secret is required', 400, 'invalid_secret');
    return;
  }
  if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret) || secret === auth.password || (!config.demo && (secret.startsWith('REPLACE_') || secret === 'demo-hub-secret'))) {
    throw errorWithStatus('Invalid Hub secret', 400, 'invalid_secret');
  }
}

function publicStatus(hub, statusMap, secretAvailable) {
  const current = statusMap?.[hub.id] ?? null;
  let state = current?.state ?? null;
  let errorCode = PUBLIC_CONNECTION_CODES.has(current?.errorCode) ? current.errorCode : null;
  if (hub.status === 'archived') {
    state = 'archived';
    errorCode = null;
  } else if (hub.status === 'disabled') {
    state = 'stopped';
    errorCode = null;
  } else if (!secretAvailable) {
    state = 'error';
    errorCode = 'missing_secret';
  }
  return {
    state,
    errorCode,
    updatedAt: current?.updatedAt ?? null,
    lastObservationAt: hub.lastObservationAt,
  };
}

function publicHub(hub, statusMap, secretRefs) {
  const hasSecret = secretRefs.has(hub.secretRef);
  return {
    id: hub.id,
    label: hub.label,
    url: hub.url,
    status: hub.status,
    version: hub.version,
    hasSecret,
    connection: publicStatus(hub, statusMap, hasSecret),
  };
}

function safeSecretRefs(config) {
  try {
    return new Set(Object.keys(readHubSecretStore(config.hubSecretsPath).secrets));
  } catch {
    // A malformed/missing store is represented as missing secrets.  Do not
    // disclose parser errors or filesystem paths through the management API.
    return new Set();
  }
}

function publicHubs(db, config, statusMap, includeArchived = false) {
  const refs = safeSecretRefs(config);
  return listHubRecords(db, {includeArchived}).map(hub => publicHub(hub, statusMap, refs));
}

function contentType(request) {
  return (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function parseBodyFactory() {
  return async request => {
    const limit = 65536;
    let total = 0;
    const chunks = [];
    for await (const chunk of request) {
      total += chunk.length;
      if (total > limit) throw errorWithStatus('Request body is too large', 413, 'body_too_large');
      chunks.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw errorWithStatus('Invalid JSON', 400, 'invalid_json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw errorWithStatus('Invalid JSON object', 400, 'invalid_json');
    return parsed;
  };
}

/**
 * Create management endpoints for SQLite-backed Hub registrations.  The
 * `onHubCommitted` callback is synchronous by design: the server uses it to
 * invalidate a retired collection generation directly after COMMIT, before
 * any subsequent await or response work.
 */
export function createManagementHandler({
  config, auth, db, live, exclusive = callback => callback(),
  getCollectionStatuses = () => ({}), onHubCommitted, onReconnect, onHistoryRequest, updateManager,
}) {
  const json = (response, data, status = 200) => {
    response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify(data));
  };
  const parseBody = parseBodyFactory();

  const requireAccess = (request, response, {write = false} = {}) => {
    if (!allowedRequest(request, config)) { json(response, {error: 'origin_rejected'}, 403); return false; }
    if (!canView(request, config, auth)) {
      if (config.viewerAuth.mode === 'basic') response.setHeader('WWW-Authenticate', 'Basic realm="Token Monitor Analytics", charset="UTF-8"');
      json(response, {error: 'viewer_auth_required'}, 401); return false;
    }
    if (write && !request.headers.origin) { json(response, {error: 'origin_required'}, 403); return false; }
    return true;
  };

  const commitNotification = result => {
    // This function is called from inside the exclusive callback directly
    // after db.transaction returns (and therefore after COMMIT).  It must not
    // become async: collection invalidation is the generation fence.
    onHubCommitted?.(result);
    live?.broadcast('manage_updated', {type: 'manage_updated'});
  };

  async function handleHubs(request, response, url) {
    const subpath = url.pathname.slice('/api/manage/hubs'.length);
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    if (subpath === '' || subpath === '/') {
      if (request.method === 'GET') {
        const refs = safeSecretRefs(config);
        const hubs = listHubRecords(db, {includeArchived}).map(hub => publicHub(hub, getCollectionStatuses(), refs));
        json(response, {hubs});
        return;
      }
      if (request.method !== 'POST') { json(response, {error: 'method_not_allowed'}, 405); return; }
      if (contentType(request) !== 'application/json') { json(response, {error: 'json_required'}, 415); return; }
      let body;
      try { body = await parseBody(request); } catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      const {id, label, url: hubUrl, secret} = body ?? {};
      if (!isSafeId(id)) { json(response, {error: 'invalid_hub_id'}, 400); return; }
      if (typeof label !== 'string' || !label.trim() || label.length > MAX_HUB_LABEL) { json(response, {error: 'invalid_label'}, 400); return; }
      let canonicalUrl;
      try { canonicalUrl = validateHubUrl(hubUrl); } catch { json(response, {error: 'invalid_url'}, 400); return; }
      try { validateSecret(secret, auth, config, {required: true}); } catch (error) { json(response, {error: publicErrorCode(error, 'invalid_secret')}, publicHttpStatus(error, 400)); return; }

      try {
        const result = await exclusive(() => {
          if (getHubRecord(db, id)) throw errorWithStatus('Hub ID is already registered', 409, 'hub_id_exists');
          if (countNonArchivedHubs(db) >= MAX_HUBS) throw errorWithStatus('Maximum active/disabled Hub count reached', 400, 'hub_limit');
          if (db.prepare("SELECT 1 FROM hubs WHERE status <> 'archived' AND url=?").bind(canonicalUrl).get()) throw errorWithStatus('Hub URL is already registered', 400, 'hub_url_exists');
          // Secret file first; a later DB failure leaves only an unreferenced
          // entry that explicit stopped-state maintenance may remove.
          const secretRef = writeHubSecret(config.hubSecretsPath, secret);
          const row = db.transaction(() => insertHub(db, {id, label: label.trim(), url: canonicalUrl, status: 'active', secretRef}));
          const result = {row, reconnect: true, reason: 'created'};
          commitNotification(result);
          return result;
        });
        json(response, {ok: true, hub: publicHub(result.row, getCollectionStatuses(), new Set([result.row.secretRef]))});
      } catch (error) {
        json(response, {error: publicErrorCode(error, 'save_failed'), currentVersion: publicCurrentVersion(error)}, publicHttpStatus(error, 500));
      }
      return;
    }

    const historyMatch = subpath.match(/^\/([^/]+)\/history$/);
    if (historyMatch) {
      let historyId;
      try { historyId = decodeHubId(historyMatch[1]); }
      catch (error) { json(response, {error: publicErrorCode(error, 'invalid_hub_id')}, publicHttpStatus(error, 400)); return; }
      if (!isSafeId(historyId) || request.method !== 'POST') {
        json(response, {error: request.method === 'POST' ? 'invalid_hub_id' : 'method_not_allowed'}, request.method === 'POST' ? 400 : 405);
        return;
      }
      if (contentType(request) !== 'application/json') { json(response, {error: 'json_required'}, 415); return; }
      try { await parseBody(request); }
      catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      const hub = getHubRecord(db, historyId);
      if (!hub || hub.status === 'archived') { json(response, {error: 'hub_not_found'}, 404); return; }
      if (hub.status !== 'active') { json(response, {error: 'history_unavailable'}, 409); return; }
      if (!safeSecretRefs(config).has(hub.secretRef)) { json(response, {error: 'missing_secret'}, 409); return; }
      try {
        const accepted = await onHistoryRequest?.(historyId);
        if (!accepted) { json(response, {error: 'history_not_ready'}, 409); return; }
        live?.broadcast('manage_updated', {type: 'manage_updated'});
        json(response, {ok: true, requested: true}, 202);
      } catch (error) {
        json(response, {error: publicErrorCode(error, 'history_unavailable')}, publicHttpStatus(error, 409));
      }
      return;
    }

    if (subpath.endsWith('/reconnect')) {
      let reconnectId;
      try { reconnectId = decodeHubId(subpath.slice(1, -'/reconnect'.length)); }
      catch (error) { json(response, {error: publicErrorCode(error, 'invalid_hub_id')}, publicHttpStatus(error, 400)); return; }
      if (!isSafeId(reconnectId) || request.method !== 'POST') { json(response, {error: request.method === 'POST' ? 'invalid_hub_id' : 'method_not_allowed'}, request.method === 'POST' ? 400 : 405); return; }
      const hub = getHubRecord(db, reconnectId);
      if (!hub || hub.status !== 'active') { json(response, {error: 'hub_not_found'}, 404); return; }
      if (!safeSecretRefs(config).has(hub.secretRef)) { json(response, {error: 'missing_secret'}, 409); return; }
      onReconnect?.(reconnectId);
      live?.broadcast('manage_updated', {type: 'manage_updated'});
      json(response, {ok: true});
      return;
    }
    let targetId;
    try { targetId = decodeHubId(subpath.replace(/^\//, '')); }
    catch (error) { json(response, {error: publicErrorCode(error, 'invalid_hub_id')}, publicHttpStatus(error, 400)); return; }
    if (!isSafeId(targetId)) { json(response, {error: 'invalid_hub_id'}, 400); return; }
    if (request.method === 'PUT') {
      if (contentType(request) !== 'application/json') { json(response, {error: 'json_required'}, 415); return; }
      let body;
      try { body = await parseBody(request); } catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      const version = expectedVersion(body, url);
      if (version === null) { json(response, {error: 'expected_version_required'}, 400); return; }
      const {label, url: hubUrl, secret, status} = body ?? {};
      try {
        if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > MAX_HUB_LABEL)) throw errorWithStatus('Invalid Hub label', 400, 'invalid_label');
        let canonicalUrl;
        if (hubUrl !== undefined) canonicalUrl = validateHubUrl(hubUrl);
        if (status !== undefined && status !== 'active' && status !== 'disabled') throw errorWithStatus('Invalid Hub status', 400, 'invalid_status');
        validateSecret(secret, auth, config);
        const result = await exclusive(() => {
          const current = getHubRecord(db, targetId);
          if (!current || current.status === 'archived') throw errorWithStatus('Hub not found', 404, 'hub_not_found');
          if (current.version !== version) throw Object.assign(errorWithStatus('Hub was modified by another request', 409, 'version_conflict'), {currentVersion: current.version});
          const nextUrl = canonicalUrl ?? current.url;
          if (db.prepare("SELECT 1 FROM hubs WHERE status <> 'archived' AND url=? AND id<>?").bind(nextUrl, targetId).get()) throw errorWithStatus('Hub URL is already registered', 400, 'hub_url_exists');
          const nextStatus = status ?? current.status;
          const currentSecret = typeof secret === 'string' && secret
            ? readHubSecret(config.hubSecretsPath, current.secretRef)
            : null;
          // The same submitted value keeps the old opaque reference and does
          // not force a reconnect.
          const nextRef = secret === undefined || secret === '' || secret === currentSecret
            ? current.secretRef
            : writeHubSecret(config.hubSecretsPath, secret);
          const row = db.transaction(() => updateHubRecord(db, targetId, version, {
            label: label === undefined ? current.label : label.trim(), url: nextUrl, status: nextStatus, secretRef: nextRef,
          }));
          const result = {
            row,
            reconnect: current.url !== row.url || current.status !== row.status || current.secretRef !== row.secretRef,
            reason: current.secretRef !== row.secretRef ? 'secret_changed' : current.url !== row.url ? 'url_changed' : current.status !== row.status ? 'status_changed' : 'metadata_changed',
          };
          commitNotification(result);
          return result;
        });
        json(response, {ok: true, hub: publicHub(result.row, getCollectionStatuses(), safeSecretRefs(config))});
      } catch (error) {
        json(response, {error: publicErrorCode(error, 'update_failed'), currentVersion: publicCurrentVersion(error)}, publicHttpStatus(error, 500));
      }
      return;
    }
    if (request.method === 'DELETE') {
      let body = {};
      if (contentType(request) === 'application/json') {
        try { body = await parseBody(request); } catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      }
      const version = expectedVersion(body, url);
      if (version === null) { json(response, {error: 'expected_version_required'}, 400); return; }
      if (config.contracts.some(contract => contract.hubId === targetId)) { json(response, {error: 'hub_referenced_by_contract'}, 400); return; }
      try {
        const result = await exclusive(() => {
          const current = getHubRecord(db, targetId);
          if (!current || current.status === 'archived') throw errorWithStatus('Hub not found', 404, 'hub_not_found');
          if (current.version !== version) throw Object.assign(errorWithStatus('Hub was modified by another request', 409, 'version_conflict'), {currentVersion: current.version});
          const row = db.transaction(() => archiveHubRecord(db, targetId, version));
          const result = {row, reconnect: true, reason: 'archived'};
          commitNotification(result);
          return result;
        });
        json(response, {ok: true, hub: publicHub(result.row, getCollectionStatuses(), safeSecretRefs(config))});
      } catch (error) {
        json(response, {error: publicErrorCode(error, 'delete_failed'), currentVersion: publicCurrentVersion(error)}, publicHttpStatus(error, 500));
      }
      return;
    }
    json(response, {error: 'method_not_allowed'}, 405);
  }

  async function handleUpdate(request, response, url) {
    if (!updateManager) { json(response, {error: 'update_manager_unavailable'}, 500); return; }
    const subpath = url.pathname.slice('/api/manage/update'.length);
    if (subpath === '' || subpath === '/') {
      if (request.method === 'GET') { json(response, updateManager.getStatus()); return; }
      json(response, {error: 'method_not_allowed'}, 405); return;
    }
    if (subpath === '/check') {
      if (request.method !== 'POST') { json(response, {error: 'method_not_allowed'}, 405); return; }
      if (contentType(request) !== 'application/json') { json(response, {error: 'json_required'}, 415); return; }
      try { await parseBody(request); }
      catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      try { await updateManager.checkUpdate(); json(response, updateManager.getStatus()); }
      catch { json(response, {error: 'check_failed'}, 500); }
      return;
    }
    if (subpath === '/apply') {
      if (request.method !== 'POST') { json(response, {error: 'method_not_allowed'}, 405); return; }
      if (contentType(request) !== 'application/json') { json(response, {error: 'json_required'}, 415); return; }
      let body;
      try { body = await parseBody(request); } catch (error) { json(response, {error: publicErrorCode(error, 'invalid_json')}, publicHttpStatus(error, 400)); return; }
      try { json(response, await updateManager.applyUpdate({targetCommitSha: body?.targetCommitSha}), 202); }
      catch (error) { json(response, {error: publicErrorCode(error, 'apply_failed')}, publicHttpStatus(error, 500)); }
      return;
    }
    json(response, {error: 'not_found'}, 404);
  }

  return {
    async handleManage(request, response, url) {
      if (!config.management?.enabled) { json(response, {error: 'not_found'}, 404); return; }
      if (!requireAccess(request, response, {write: ['POST', 'PUT', 'DELETE'].includes(request.method)})) return;
      if (url.pathname === '/api/manage/hubs' || url.pathname.startsWith('/api/manage/hubs/')) { await handleHubs(request, response, url); return; }
      if (url.pathname === '/api/manage/update' || url.pathname.startsWith('/api/manage/update/')) { await handleUpdate(request, response, url); return; }
      json(response, {error: 'not_found'}, 404);
    },
    listHubs: (includeArchived = false) => publicHubs(db, config, getCollectionStatuses(), includeArchived),
  };
}
