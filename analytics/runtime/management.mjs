import {toHubViewItems, validateHubUrl, isSafeId} from '../src/hubs.ts';
import {readHubsConfig, saveHubsTransaction} from './hubs.mjs';
import {canIngest, canView, allowedRequest} from './auth.mjs';

export class CollectorStatusTracker {
  #lastReport = null;
  #lastReportTime = 0;
  #timeoutMs;

  constructor({timeoutMs = 45000} = {}) {
    this.#timeoutMs = timeoutMs;
  }

  update(report) {
    this.#lastReport = report;
    this.#lastReportTime = Date.now();
  }

  getSnapshot() {
    if (!this.#lastReport) {
      return {
        status: 'unknown',
        appliedRevision: null,
        hubs: {},
        lastReportAt: null
      };
    }
    const isStale = Date.now() - this.#lastReportTime > this.#timeoutMs;
    if (isStale) {
      return {
        status: 'unknown',
        appliedRevision: this.#lastReport.appliedRevision,
        hubs: {},
        lastReportAt: new Date(this.#lastReportTime).toISOString()
      };
    }

    const hubsMap = {};
    if (Array.isArray(this.#lastReport.hubs)) {
      for (const h of this.#lastReport.hubs) {
        if (h && typeof h.id === 'string') {
          hubsMap[h.id] = {
            status: h.status,
            errorCode: h.errorCode || null,
            updatedAt: h.updatedAt
          };
        }
      }
    }

    return {
      status: 'active',
      appliedRevision: this.#lastReport.appliedRevision,
      hubs: hubsMap,
      lastReportAt: new Date(this.#lastReportTime).toISOString()
    };
  }
}

export function createManagementHandler({config, auth, db, live, tracker, getIngestHubIds, setIngestHubIds, exclusive}) {
  const json = (res, data, status = 200) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(data));
  };

  const parseJsonBody = async (req) => {
    const limit = 65536;
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw Object.assign(new Error('body_too_large'), {status: 413});
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  return {
    async handleCollectorStatus(req, res) {
      if (req.method !== 'POST') {
        json(res, {error: 'method_not_allowed'}, 405);
        return;
      }
      if (!canIngest(req, auth)) {
        json(res, {error: 'unauthorized'}, 401);
        return;
      }
      const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        json(res, {error: 'json_required'}, 415);
        return;
      }

      let payload;
      try {
        payload = await parseJsonBody(req);
      } catch (err) {
        json(res, {error: 'invalid_json'}, err.status || 400);
        return;
      }

      if (!payload || typeof payload !== 'object' || typeof payload.appliedRevision !== 'number') {
        json(res, {error: 'invalid_status_payload'}, 400);
        return;
      }

      tracker.update(payload);
      // Notify browser SSE of status change
      live.broadcast('manage_updated', {type: 'manage_updated'});
      json(res, {ok: true});
    },

    async handleManage(req, res, url) {
      if (!config.management?.enabled) {
        json(res, {error: 'not_found'}, 404);
        return;
      }
      if (!allowedRequest(req, config)) {
        json(res, {error: 'origin_rejected'}, 403);
        return;
      }
      if (!canView(req, config, auth)) {
        if (config.viewerAuth.mode === 'basic') {
          res.setHeader('WWW-Authenticate', 'Basic realm="Token Monitor Analytics", charset="UTF-8"');
        }
        json(res, {error: 'viewer_auth_required'}, 401);
        return;
      }

      // /api/manage/hubs or /api/manage/hubs/:id
      const subpath = url.pathname.slice('/api/manage/hubs'.length);

      if (subpath === '' || subpath === '/') {
        if (req.method === 'GET') {
          try {
            const {hubsFile, secretsFile} = readHubsConfig(config.hubsPath);
            const items = toHubViewItems(hubsFile.hubs, secretsFile.secrets);
            const collectorSnapshot = tracker.getSnapshot();
            json(res, {
              revision: hubsFile.revision,
              hubs: items,
              collector: collectorSnapshot,
              contracts: config.contracts
            });
          } catch (err) {
            json(res, {error: 'load_failed', message: err.message}, 500);
          }
          return;
        }

        if (req.method === 'POST') {
          const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (ct !== 'application/json') {
            json(res, {error: 'json_required'}, 415);
            return;
          }
          let body;
          try {
            body = await parseJsonBody(req);
          } catch (err) {
            json(res, {error: 'invalid_json'}, err.status || 400);
            return;
          }

          const {expectedRevision, id, label, url: hubUrl, secret} = body ?? {};
          if (typeof expectedRevision !== 'number') {
            json(res, {error: 'expectedRevision is required'}, 400);
            return;
          }
          if (!isSafeId(id)) {
            json(res, {error: 'invalid_hub_id', message: 'Hub ID must be 1..64 alphanumeric/dash/underscore'}, 400);
            return;
          }
          if (typeof label !== 'string' || !label.trim() || label.length > 128) {
            json(res, {error: 'invalid_label', message: 'Label must be 1..128 characters'}, 400);
            return;
          }
          let canonicalUrl;
          try {
            canonicalUrl = validateHubUrl(hubUrl);
          } catch (err) {
            json(res, {error: 'invalid_url', message: err.message}, 400);
            return;
          }
          if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret)) {
            json(res, {error: 'invalid_secret', message: 'Secret must be non-empty without newlines'}, 400);
            return;
          }

          try {
            const result = await exclusive(async () => {
              return await saveHubsTransaction(config.hubsPath, expectedRevision, ({hubs, createSecretRef}) => {
                if (hubs.some(h => h.id === id)) {
                  throw Object.assign(new Error(`Hub ID ${id} already exists`), {status: 400});
                }
                const activeUrls = new Set(hubs.filter(h => h.status !== 'archived').map(h => h.url));
                if (activeUrls.has(canonicalUrl)) {
                  throw Object.assign(new Error(`Hub URL ${canonicalUrl} already registered`), {status: 400});
                }
                const activeCount = hubs.filter(h => h.status !== 'archived').length;
                if (activeCount >= 8) {
                  throw Object.assign(new Error('Maximum 8 active/disabled hubs allowed'), {status: 400});
                }

                const secretRef = createSecretRef(secret);
                return [
                  ...hubs,
                  {
                    id,
                    label: label.trim(),
                    url: canonicalUrl,
                    status: 'active',
                    secretRef
                  }
                ];
              });
            });

            // Update allowed hub IDs in memory
            const activeHubs = result.hubsFile.hubs.map(h => h.id);
            setIngestHubIds(activeHubs);

            live.broadcast('manage_updated', {type: 'manage_updated'});
            json(res, {ok: true, revision: result.hubsFile.revision});
          } catch (err) {
            json(res, {error: err.status === 409 ? 'revision_conflict' : 'save_failed', message: err.message, currentRevision: err.currentRevision}, err.status || 500);
          }
          return;
        }

        json(res, {error: 'method_not_allowed'}, 405);
        return;
      }

      // Subpath /api/manage/hubs/:id
      const targetId = decodeURIComponent(subpath.replace(/^\//, ''));
      if (!isSafeId(targetId)) {
        json(res, {error: 'invalid_hub_id'}, 400);
        return;
      }

      if (req.method === 'PUT') {
        const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') {
          json(res, {error: 'json_required'}, 415);
          return;
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch (err) {
          json(res, {error: 'invalid_json'}, err.status || 400);
          return;
        }

        const {expectedRevision, label, url: hubUrl, secret, status} = body ?? {};
        if (typeof expectedRevision !== 'number') {
          json(res, {error: 'expectedRevision is required'}, 400);
          return;
        }

        try {
          const result = await exclusive(async () => {
            return await saveHubsTransaction(config.hubsPath, expectedRevision, ({hubs, createSecretRef}) => {
              const index = hubs.findIndex(h => h.id === targetId);
              if (index === -1 || hubs[index].status === 'archived') {
                throw Object.assign(new Error(`Hub ${targetId} not found`), {status: 404});
              }
              const current = hubs[index];
              let nextLabel = current.label;
              let nextUrl = current.url;
              let nextStatus = current.status;
              let nextSecretRef = current.secretRef;

              if (label !== undefined) {
                if (typeof label !== 'string' || !label.trim() || label.length > 128) {
                  throw Object.assign(new Error('Label must be 1..128 characters'), {status: 400});
                }
                nextLabel = label.trim();
              }

              if (hubUrl !== undefined) {
                const canonical = validateHubUrl(hubUrl);
                const otherUrls = new Set(hubs.filter((h, i) => i !== index && h.status !== 'archived').map(h => h.url));
                if (otherUrls.has(canonical)) {
                  throw Object.assign(new Error(`Hub URL ${canonical} already in use`), {status: 400});
                }
                nextUrl = canonical;
              }

              if (status !== undefined) {
                if (status !== 'active' && status !== 'disabled') {
                  throw Object.assign(new Error('Status must be active or disabled'), {status: 400});
                }
                nextStatus = status;
              }

              if (secret !== undefined && secret !== '') {
                if (typeof secret !== 'string' || /[\r\n\0]/.test(secret)) {
                  throw Object.assign(new Error('Invalid secret string'), {status: 400});
                }
                nextSecretRef = createSecretRef(secret);
              }

              const updatedList = [...hubs];
              updatedList[index] = {
                id: current.id,
                label: nextLabel,
                url: nextUrl,
                status: nextStatus,
                secretRef: nextSecretRef
              };
              return updatedList;
            });
          });

          const activeHubs = result.hubsFile.hubs.map(h => h.id);
          setIngestHubIds(activeHubs);

          live.broadcast('manage_updated', {type: 'manage_updated'});
          json(res, {ok: true, revision: result.hubsFile.revision});
        } catch (err) {
          json(res, {error: err.status === 409 ? 'revision_conflict' : 'update_failed', message: err.message, currentRevision: err.currentRevision}, err.status || 500);
        }
        return;
      }

      if (req.method === 'DELETE') {
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          body = {};
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : Number(url.searchParams.get('expectedRevision'));
        if (Number.isNaN(expectedRevision)) {
          json(res, {error: 'expectedRevision is required'}, 400);
          return;
        }

        // Check if contract references this hub
        if (config.contracts.some(c => c.hubId === targetId)) {
          json(res, {
            error: 'hub_referenced_by_contract',
            message: `Hub ${targetId} is referenced by an active contract. Disable the hub instead of deleting it.`
          }, 400);
          return;
        }

        try {
          const result = await exclusive(async () => {
            return await saveHubsTransaction(config.hubsPath, expectedRevision, ({hubs}) => {
              const index = hubs.findIndex(h => h.id === targetId);
              if (index === -1 || hubs[index].status === 'archived') {
                throw Object.assign(new Error(`Hub ${targetId} not found`), {status: 404});
              }

              // Archive hub
              const updatedList = [...hubs];
              updatedList[index] = {
                ...hubs[index],
                status: 'archived'
              };
              return updatedList;
            });
          });

          // Ingest still accepts observations for archived hubs (to drain outbox)
          const validHubs = result.hubsFile.hubs.map(h => h.id);
          setIngestHubIds(validHubs);

          live.broadcast('manage_updated', {type: 'manage_updated'});
          json(res, {ok: true, revision: result.hubsFile.revision});
        } catch (err) {
          json(res, {error: err.status === 409 ? 'revision_conflict' : 'delete_failed', message: err.message, currentRevision: err.currentRevision}, err.status || 500);
        }
        return;
      }

      json(res, {error: 'method_not_allowed'}, 405);
    }
  };
}
