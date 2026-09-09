import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MAX_CONFIG_BYTES, validateHubsFile, validateHubSecretsFile} from '../src/hubs.ts';

export function writeAtomicFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  const rand = crypto.randomBytes(4).toString('hex');
  const tempPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${Date.now()}-${rand}`);
  
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  let replaced = false;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      replaced = true;
      break;
    } catch (err) {
      lastError = err;
      // POSIX rename replaces an existing destination atomically.  Windows
      // refuses that operation while the destination exists, so briefly move
      // the old name aside and restore it if the replacement cannot finish.
      // The retry loop still gives readers holding the file a chance to close.
      if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM' || err?.code === 'EBUSY')) {
        const backupPath = path.join(dir, `.old-${path.basename(targetPath)}-${Date.now()}-${rand}`);
        try {
          if (fs.existsSync(targetPath)) fs.renameSync(targetPath, backupPath);
          fs.renameSync(tempPath, targetPath);
          try { fs.unlinkSync(backupPath); } catch {}
          replaced = true;
          break;
        } catch (replaceError) {
          lastError = replaceError;
          try {
            if (!fs.existsSync(targetPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
          } catch {}
        }
      }
      const start = Date.now();
      while (Date.now() - start < 15) {}
    }
  }
  if (!replaced) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw lastError;
  }
  // Persist the rename where the platform supports directory fsync.  Windows
  // does not permit opening directories this way, so the durable file fsync
  // above remains the portable minimum.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {}
}

export function readHubsConfig(hubsFilePath) {
  const absHubsPath = path.resolve(hubsFilePath);
  if (!fs.existsSync(absHubsPath)) {
    throw Object.assign(new Error(`Hubs config file not found: ${absHubsPath}`), {status: 404});
  }
  const hubsStat = fs.statSync(absHubsPath);
  if (hubsStat.size > MAX_CONFIG_BYTES) {
    throw Object.assign(new Error('Hubs config file too large'), {status: 413});
  }
  const hubsRaw = JSON.parse(fs.readFileSync(absHubsPath, 'utf8').replace(/^\uFEFF/, ''));
  const hubsFile = validateHubsFile(hubsRaw);

  const secretsFilePath = path.resolve(path.dirname(absHubsPath), hubsFile.secretsPath);
  if (!fs.existsSync(secretsFilePath)) {
    throw Object.assign(new Error(`Secrets file not found: ${secretsFilePath}`), {status: 404});
  }
  const secretsStat = fs.statSync(secretsFilePath);
  if (secretsStat.size > MAX_CONFIG_BYTES) {
    throw Object.assign(new Error('Secrets file too large'), {status: 413});
  }
  const secretsRaw = JSON.parse(fs.readFileSync(secretsFilePath, 'utf8').replace(/^\uFEFF/, ''));
  const secretsFile = validateHubSecretsFile(secretsRaw);

  for (const hub of hubsFile.hubs) {
    if (!secretsFile.secrets[hub.secretRef]) {
      throw new Error(`Secret reference ${hub.secretRef} for hub ${hub.id} not found in secrets file`);
    }
  }

  return { hubsFile, secretsFile, secretsFilePath };
}

let saveTail = Promise.resolve();

export function saveHubsTransaction(hubsFilePath, expectedRevision, mutator) {
  const run = async () => {
    const {hubsFile, secretsFile, secretsFilePath} = readHubsConfig(hubsFilePath);
    if (expectedRevision !== undefined && expectedRevision !== null && hubsFile.revision !== expectedRevision) {
      throw Object.assign(new Error('Revision conflict: configuration was modified by another request'), {
        status: 409,
        currentRevision: hubsFile.revision
      });
    }

    const nextSecrets = {...secretsFile.secrets};
    let newSecretAdded = false;

    const generateSecretRef = (secretValue) => {
      const ref = `sec-${crypto.randomBytes(8).toString('hex')}`;
      nextSecrets[ref] = secretValue;
      newSecretAdded = true;
      return ref;
    };

    const nextHubs = mutator({
      hubs: [...hubsFile.hubs],
      createSecretRef: generateSecretRef,
      currentSecrets: nextSecrets
    });

    const nextHubsFile = validateHubsFile({
      schemaVersion: 1,
      revision: hubsFile.revision + 1,
      secretsPath: hubsFile.secretsPath,
      hubs: nextHubs
    });

    const nextSecretsFile = validateHubSecretsFile({
      schemaVersion: 1,
      secrets: nextSecrets
    });

    // Verify all referenced secrets exist
    for (const hub of nextHubsFile.hubs) {
      if (!nextSecretsFile.secrets[hub.secretRef]) {
        throw new Error(`Missing secret for hub ${hub.id}`);
      }
    }

    // Check both serialized files before either write. Readers enforce this same limit.
    const hubsContent = JSON.stringify(nextHubsFile, null, 2) + '\n';
    const secretsContent = JSON.stringify(nextSecretsFile, null, 2) + '\n';
    if (Buffer.byteLength(hubsContent, 'utf8') > MAX_CONFIG_BYTES ||
        Buffer.byteLength(secretsContent, 'utf8') > MAX_CONFIG_BYTES) {
      throw Object.assign(new Error('Configuration exceeds storage size limit'), {status: 413});
    }

    // Step 2: If new secrets were added, update secrets file first
    if (newSecretAdded) {
      writeAtomicFile(secretsFilePath, secretsContent);
    }

    // Step 3: Replace hubs.json (commit point)
    writeAtomicFile(hubsFilePath, hubsContent);

    return {
      hubsFile: nextHubsFile,
      secretsFile: nextSecretsFile,
      secretsFilePath
    };
  };

  const current = saveTail.then(run);
  saveTail = current.catch(() => {});
  return current;
}

/*
 * The functions below are the SQLite-backed Hub store used by the integrated
 * Node application.  The file helpers above remain available to the explicit
 * one-time migration tooling; normal runtime code never reads or writes a
 * hubs.json registration file.
 */

export const HUB_SECRET_FILE_VERSION = 1;

function secretPathValue(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('Hub secret path is required');
  return path.resolve(filename);
}

/** Read the separate secret store without exposing its path or values. */
export function readHubSecretStore(filename, {allowMissing = true} = {}) {
  const absolute = secretPathValue(filename);
  if (!fs.existsSync(absolute)) {
    if (allowMissing) return {secrets: {}, exists: false};
    throw Object.assign(new Error('Hub secret store is missing'), {code: 'secret_store_missing'});
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw Object.assign(new Error('Hub secret store is invalid'), {code: 'secret_store_invalid'});
  let raw;
  try { raw = JSON.parse(fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('Hub secret store is invalid'), {code: 'secret_store_invalid'}); }
  try {
    const file = validateHubSecretsFile(raw);
    return {secrets: file.secrets, exists: true};
  } catch {
    throw Object.assign(new Error('Hub secret store is invalid'), {code: 'secret_store_invalid'});
  }
}

export function readHubSecret(filename, secretRef, options) {
  if (typeof secretRef !== 'string' || !secretRef) return null;
  const store = readHubSecretStore(filename, options);
  const value = store.secrets[secretRef];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Add a new opaque secret reference and atomically replace the secret file.
 * The caller must perform the DB reference update only after this returns.
 */
export function writeHubSecret(filename, secret) {
  if (typeof secret !== 'string' || !secret || /[\r\n\0]/.test(secret)) throw new Error('Invalid Hub secret');
  const absolute = secretPathValue(filename);
  const current = readHubSecretStore(absolute).secrets;
  let ref;
  do { ref = `sec-${crypto.randomBytes(16).toString('hex')}`; } while (Object.prototype.hasOwnProperty.call(current, ref));
  const next = {...current, [ref]: secret};
  const content = JSON.stringify({schemaVersion: HUB_SECRET_FILE_VERSION, secrets: next}, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw Object.assign(new Error('Hub secret store is full'), {status: 413});
  fs.mkdirSync(path.dirname(absolute), {recursive: true, mode: 0o700});
  writeAtomicFile(absolute, content);
  return ref;
}

function cleanHubRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    status: row.status,
    secretRef: row.secret_ref,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastObservationAt: row.last_observed_at ?? null,
  };
}

export function listHubRecords(db, {includeArchived = true} = {}) {
  const where = includeArchived ? '' : " WHERE h.status <> 'archived'";
  return db.prepare(`SELECT h.id,h.label,h.url,h.status,h.secret_ref,h.version,h.created_at,h.updated_at,
      latest.observed_at AS last_observed_at
    FROM hubs h LEFT JOIN hub_latest latest ON latest.hub_id=h.id${where} ORDER BY h.created_at,h.id`).all().map(cleanHubRow);
}

export function getHubRecord(db, id) {
  return cleanHubRow(db.prepare(`SELECT h.id,h.label,h.url,h.status,h.secret_ref,h.version,h.created_at,h.updated_at,
      latest.observed_at AS last_observed_at
    FROM hubs h LEFT JOIN hub_latest latest ON latest.hub_id=h.id WHERE h.id=?`).bind(id).get());
}

export function countNonArchivedHubs(db) {
  return Number(db.prepare("SELECT count(*) AS n FROM hubs WHERE status <> 'archived'").get()?.n ?? 0);
}

export function hubVersionConflict(currentVersion) {
  return Object.assign(new Error('Hub was modified by another request'), {
    status: 409,
    code: 'version_conflict',
    currentVersion: currentVersion === undefined ? null : Number(currentVersion),
  });
}

export function nowIso() { return new Date().toISOString(); }

export function insertHub(db, input, now = nowIso()) {
  db.prepare(`INSERT INTO hubs(id,label,url,status,secret_ref,version,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?)`).bind(
    input.id, input.label, input.url, input.status, input.secretRef, now, now
  ).run();
  db.prepare(`INSERT INTO hub_snapshots(hub_id,hub_version,label,url,status,captured_at) VALUES(?,?,?,?,?,?)`)
    .bind(input.id, 1, input.label, input.url, input.status, now).run();
  return getHubRecord(db, input.id);
}

export function updateHubRecord(db, id, expectedVersion, patch, now = nowIso()) {
  const current = getHubRecord(db, id);
  if (!current || current.status === 'archived') {
    throw Object.assign(new Error('Hub not found'), {status: 404, code: 'hub_not_found'});
  }
  if (current.version !== expectedVersion) throw hubVersionConflict(current.version);
  const next = {
    ...current,
    ...patch,
    version: current.version + 1,
    updatedAt: now,
  };
  db.prepare(`UPDATE hubs SET label=?,url=?,status=?,secret_ref=?,version=?,updated_at=? WHERE id=? AND version=?`)
    .bind(next.label, next.url, next.status, next.secretRef, next.version, next.updatedAt, id, expectedVersion).run();
  db.prepare(`INSERT INTO hub_snapshots(hub_id,hub_version,label,url,status,captured_at) VALUES(?,?,?,?,?,?)`)
    .bind(id, next.version, next.label, next.url, next.status, now).run();
  return getHubRecord(db, id);
}

export function archiveHubRecord(db, id, expectedVersion, now = nowIso()) {
  return updateHubRecord(db, id, expectedVersion, {status: 'archived'}, now);
}

/** Store current contract definitions for history descriptions. */
export function recordContractSnapshots(db, contracts, now = nowIso()) {
  for (const contract of Array.isArray(contracts) ? contracts : []) {
    const definition = JSON.stringify(contract);
    const hash = crypto.createHash('sha256').update(definition).digest('hex');
    db.prepare(`INSERT OR IGNORE INTO contract_snapshots(contract_id,definition_hash,hub_id,label,definition_json,captured_at)
      VALUES(?,?,?,?,?,?)`).bind(contract.id, hash, contract.hubId, contract.label, definition, now).run();
  }
}

/** Return immutable contract definitions kept for historical descriptions. */
export function listContractSnapshots(db) {
  return db.prepare(`SELECT contract_id,definition_hash,hub_id,label,definition_json,captured_at
    FROM contract_snapshots ORDER BY captured_at DESC,contract_id,definition_hash`).all().flatMap(row => {
    try {
      const definition = JSON.parse(row.definition_json);
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
      return [{
        id: row.contract_id,
        definitionHash: row.definition_hash,
        hubId: row.hub_id,
        label: row.label,
        definition,
        capturedAt: row.captured_at,
      }];
    } catch {
      return [];
    }
  });
}
