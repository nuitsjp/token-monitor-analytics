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
      const start = Date.now();
      while (Date.now() - start < 15) {}
    }
  }
  if (!replaced) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw lastError;
  }
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

    // Step 2: If new secrets were added, update secrets file first
    if (newSecretAdded) {
      writeAtomicFile(secretsFilePath, JSON.stringify(nextSecretsFile, null, 2) + '\n');
    }

    // Step 3: Replace hubs.json (commit point)
    writeAtomicFile(hubsFilePath, JSON.stringify(nextHubsFile, null, 2) + '\n');

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
