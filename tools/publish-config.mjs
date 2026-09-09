import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,credentials} from '../analytics/runtime/config.mjs';
import {treeDigest,releaseContentHash,configurationId,withPublicationLock,assertOldLayout,verifyReleaseArtifact,createReleaseArtifact,RELEASE_SCHEMA_VERSION,RUNTIME_CONTRACT_VERSION,MIN_NODE_VERSION} from './release.mjs';

export {treeDigest,releaseContentHash,configurationId,withPublicationLock,assertOldLayout,verifyReleaseArtifact,createReleaseArtifact,RELEASE_SCHEMA_VERSION,RUNTIME_CONTRACT_VERSION,MIN_NODE_VERSION};

export const destination = '/var/lib/tma-deploy/config';

export function readJSON(filename) {
  let text;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    const target = JSON.stringify(path.resolve(filename));
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`Deployment JSON not found: ${target}`), {missingFile: true});
    if (['EACCES', 'EPERM'].includes(error?.code)) throw Object.assign(new Error(`Permission denied reading deployment JSON: ${target}`), {needsRootRead: true});
    throw new Error(`Cannot read deployment JSON file: ${target}`);
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON syntax in ${JSON.stringify(path.resolve(filename))}; inspect the file locally. File contents are not displayed.`); }
}

// Parse only a small EnvironmentFile subset. Never source a shell file or
// interpolate a secret into a command line.
export function readEnvironment(filename) {
  const stat = fs.statSync(filename);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Environment files must have mode 0600 (or stricter).');
  const env = Object.create(null);
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\\\r\n\0]*)"|'([^'\r\n\0]*)'|([^\s'"\\\r\n\0]+))$/.exec(line);
    if (!match || Object.hasOwn(env, match[1])) throw new Error('Invalid/duplicate environment assignment; use one KEY=value per line, optionally quoted, without escapes.');
    env[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return env;
}

export function writeChanged(filename, bytes, mode = 0o644) {
  const content = Buffer.from(bytes);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  if (fs.existsSync(filename) && fs.readFileSync(filename).equals(content)) {
    fs.chmodSync(filename, mode);
    return false;
  }
  const temporary = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, content, {mode, flag: 'wx'});
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, mode);
  } finally { fs.rmSync(temporary, {force: true}); }
  return true;
}

export function selectConfiguration(plan = {}, dir = destination) {
  const names = {analyticsConfig: 'analytics.json', analyticsEnv: 'analytics.env', hubSecrets: 'hub-secrets.json', connection: 'connection.json'};
  return Object.fromEntries(Object.entries(names).map(([key, name]) => {
    const target = path.join(dir, name);
    return [key, fs.existsSync(target) ? target : plan[key]];
  }));
}

function readSecretStore(filename) {
  if (!filename || !fs.existsSync(filename)) return {schemaVersion: 1, secrets: {}};
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Hub Secret file must be a private regular file');
  const store = readJSON(filename);
  if (store.schemaVersion !== 1 || store.secrets === null || typeof store.secrets !== 'object' || Array.isArray(store.secrets) || Object.values(store.secrets).some(value => typeof value !== 'string')) throw new Error('Hub Secret file has an invalid shape');
  return {schemaVersion: 1, secrets: {}};
}

/** Validate the one-listener configuration selected for publication. */
export function validateConfiguration(plan = {}, selected = {}) {
  if (!selected.analyticsConfig) throw new Error('Analytics configuration is missing');
  const analytics = loadConfig(selected.analyticsConfig);
  if (plan.publicOrigin !== undefined && plan.publicOrigin !== analytics.publicOrigin) throw new Error('Configured publicOrigin does not match the deployment plan');
  const analyticsEnv = selected.analyticsEnv && fs.existsSync(selected.analyticsEnv) ? readEnvironment(selected.analyticsEnv) : Object.create(null);
  const auth = credentials(analytics, analyticsEnv);
  // analytics.json is the authority for the private Hub Secret path. A
  // conventional hub-secrets.json beside the config must never shadow a
  // deliberately configured separate file.
  const secretStore = readSecretStore(analytics.hubSecretsPath);
  return {analytics, analyticsEnv, auth, secretStore, hubSecretsPath: analytics.hubSecretsPath, connection: plan};
}

export function readPublication(filename = '/opt/token-monitor-analytics/publication.json') {
  if (!fs.existsSync(filename)) return null;
  const raw = readJSON(filename);
  return {
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : null,
    releaseId: typeof raw.releaseId === 'string' ? raw.releaseId : null,
    configurationId: typeof raw.configurationId === 'string' ? raw.configurationId : null,
    publicOrigin: typeof raw.publicOrigin === 'string' ? raw.publicOrigin : null,
    commitSha: typeof raw.commitSha === 'string' ? raw.commitSha : (typeof raw.targetCommitSha === 'string' ? raw.targetCommitSha : null),
    commitDate: typeof raw.commitDate === 'string' ? raw.commitDate : (typeof raw.targetCommitDate === 'string' ? raw.targetCommitDate : null),
    targetCommitSha: typeof raw.targetCommitSha === 'string' ? raw.targetCommitSha : null,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    archiveSha256: typeof raw.archiveSha256 === 'string' ? raw.archiveSha256 : null,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null
  };
}
