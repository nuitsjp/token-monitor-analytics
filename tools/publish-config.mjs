import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {treeDigest,configurationId,withPublicationLock,assertOldLayout,verifyReleaseArtifact,createReleaseArtifact,RELEASE_SCHEMA_VERSION,RUNTIME_CONTRACT_VERSION,MIN_NODE_VERSION} from './release.mjs';

export {treeDigest,configurationId,withPublicationLock,assertOldLayout,verifyReleaseArtifact,createReleaseArtifact,RELEASE_SCHEMA_VERSION,RUNTIME_CONTRACT_VERSION,MIN_NODE_VERSION};

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

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const envName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const loopback = value => value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
const keys = (value, allowed, label) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid or unknown ${label} field`);
};

function validateConfigShape(raw) {
  keys(raw, ['version', 'listen', 'publicOrigin', 'databasePath', 'timeZone', 'detailRetentionDays', 'viewerAuth', 'hubSecretsPath', 'contracts', 'demo', 'management', 'update'], 'configuration');
  if (raw.version !== 2 || typeof raw.demo !== 'boolean') throw new Error('version=2 and explicit demo boolean are required');
  if (Object.hasOwn(raw, 'tailnetViewer') || Object.hasOwn(raw, 'hubs') || Object.hasOwn(raw, 'ingestTokenEnv')) throw new Error('Legacy Collector, Hub-file and secondary-listener settings are not supported');
  keys(raw.listen, ['host', 'port'], 'listen');
  if (isIP(raw.listen.host) === 0 || !Number.isInteger(raw.listen.port) || raw.listen.port < 1 || raw.listen.port > 65535) throw new Error('listen requires an IP literal and port 1..65535');
  if (typeof raw.publicOrigin !== 'string') throw new Error('publicOrigin is required');
  let origin;
  try { origin = new URL(raw.publicOrigin); } catch { throw new Error('publicOrigin must be a valid HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('publicOrigin must be an HTTP(S) origin without credentials or path');
  if (typeof raw.databasePath !== 'string' || !raw.databasePath.trim() || raw.databasePath === ':memory:') throw new Error('databasePath must be a file');
  if (!Number.isInteger(raw.detailRetentionDays) || raw.detailRetentionDays < 1 || raw.detailRetentionDays > 3650) throw new Error('detailRetentionDays must be 1..3650');
  if (typeof raw.timeZone !== 'string' || !raw.timeZone.trim()) throw new Error('timeZone required');
  try { new Intl.DateTimeFormat('en', {timeZone: raw.timeZone}); } catch { throw new Error('timeZone is invalid'); }
  keys(raw.viewerAuth, ['mode', 'userEnv', 'passwordEnv'], 'viewerAuth');
  if (!['loopback', 'basic', 'tailscale'].includes(raw.viewerAuth.mode)) throw new Error('viewerAuth mode must be loopback, basic or tailscale');
  if (raw.viewerAuth.mode === 'basic' && (!envName(raw.viewerAuth.userEnv) || !envName(raw.viewerAuth.passwordEnv))) throw new Error('Basic auth environment names required');
  if (raw.viewerAuth.mode === 'loopback' && !loopback(raw.listen.host)) throw new Error('Loopback viewer mode requires a loopback listener');
  if (raw.viewerAuth.mode === 'tailscale' && (loopback(raw.listen.host) || isIP(raw.listen.host) !== 4 || raw.listen.host.split('.').map(Number)[0] !== 100)) throw new Error('Tailscale viewer mode requires a dedicated Tailscale IPv4 listener');
  if (raw.demo && (!loopback(raw.listen.host) || raw.viewerAuth.mode !== 'loopback' || origin.protocol !== 'http:')) throw new Error('Demo must remain loopback-only');
  if (raw.hubSecretsPath !== undefined && (typeof raw.hubSecretsPath !== 'string' || !raw.hubSecretsPath.trim())) throw new Error('hubSecretsPath must be a non-empty string');
  if (!Array.isArray(raw.contracts)) throw new Error('contracts must be an array');
  if (raw.management !== undefined) {
    keys(raw.management, ['enabled'], 'management');
    if (typeof raw.management.enabled !== 'boolean') throw new Error('management.enabled must be a boolean');
  }
  if (raw.update !== undefined) {
    keys(raw.update, ['enabled', 'repositoryUrl', 'branch', 'checkIntervalSeconds', 'statePath', 'repoPath', 'publicationPath'], 'update');
    if (typeof raw.update.enabled !== 'boolean') throw new Error('update.enabled must be a boolean');
    for (const key of ['repositoryUrl', 'branch', 'statePath', 'repoPath', 'publicationPath']) if (raw.update[key] !== undefined && (typeof raw.update[key] !== 'string' || !raw.update[key].trim())) throw new Error(`update.${key} must be a non-empty string`);
    if (raw.update.checkIntervalSeconds !== undefined && (!Number.isInteger(raw.update.checkIntervalSeconds) || raw.update.checkIntervalSeconds < 10 || raw.update.checkIntervalSeconds > 86400)) throw new Error('update.checkIntervalSeconds must be 10..86400');
  }
  return origin;
}

function resolveConfig(raw, filename) {
  const absolute = path.resolve(filename);
  const origin = validateConfigShape(raw);
  const resolvePath = value => path.isAbsolute(value) ? path.resolve(value) : path.resolve(path.dirname(absolute), value);
  const databasePath = resolvePath(raw.databasePath);
  const hubSecretsPath = resolvePath(raw.hubSecretsPath ?? './hub-secrets.json');
  if (hubSecretsPath === databasePath || hubSecretsPath === absolute) throw new Error('hubSecretsPath must be separate from the database and configuration files');
  const updateRaw = raw.update ?? {};
  const update = {
    enabled: Boolean(updateRaw.enabled),
    repositoryUrl: updateRaw.repositoryUrl ?? 'https://github.com/nuitsjp/token-monitor-analytics.git',
    branch: updateRaw.branch ?? 'main',
    checkIntervalSeconds: updateRaw.checkIntervalSeconds ?? 300,
    statePath: updateRaw.statePath ? resolvePath(updateRaw.statePath) : '/var/lib/tma-deploy/update-state.json',
    repoPath: updateRaw.repoPath ? resolvePath(updateRaw.repoPath) : '/var/lib/tma-deploy/repo',
    publicationPath: updateRaw.publicationPath ? resolvePath(updateRaw.publicationPath) : '/opt/token-monitor-analytics/publication.json'
  };
  return {...raw, publicOrigin: origin.origin, databasePath, hubSecretsPath, configFile: absolute, management: {enabled: Boolean(raw.management?.enabled)}, update};
}

function readSecretStore(filename) {
  if (!filename || !fs.existsSync(filename)) return {schemaVersion: 1, secrets: {}};
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Hub Secret file must be a private regular file');
  const store = readJSON(filename);
  if (store.schemaVersion !== 1 || !object(store.secrets) || Object.values(store.secrets).some(value => typeof value !== 'string')) throw new Error('Hub Secret file has an invalid shape');
  return {schemaVersion: 1, secrets: {}};
}

function readCredentials(config, env) {
  if (config.viewerAuth.mode !== 'basic') return {};
  const value = (name, minimum) => {
    const result = env[name];
    if (typeof result !== 'string' || result.length < minimum || result.startsWith('REPLACE_') || /[\r\n\0]/.test(result)) throw new Error(`Missing/short/invalid environment variable: ${name}`);
    return result;
  };
  const user = value(config.viewerAuth.userEnv, 1), password = value(config.viewerAuth.passwordEnv, 16);
  if (user.includes(':')) throw new Error('Viewer username must not contain a colon');
  return {user, password};
}

/** Validate the one-listener configuration selected for publication. */
export function validateConfiguration(plan = {}, selected = {}) {
  if (!selected.analyticsConfig) throw new Error('Analytics configuration is missing');
  const raw = readJSON(selected.analyticsConfig);
  const analytics = resolveConfig(raw, selected.analyticsConfig);
  if (plan.publicOrigin !== undefined && plan.publicOrigin !== analytics.publicOrigin) throw new Error('Configured publicOrigin does not match the deployment plan');
  const analyticsEnv = selected.analyticsEnv && fs.existsSync(selected.analyticsEnv) ? readEnvironment(selected.analyticsEnv) : Object.create(null);
  const auth = readCredentials(analytics, analyticsEnv);
  const secretStore = readSecretStore(selected.hubSecrets ?? analytics.hubSecretsPath);
  return {analytics, analyticsEnv, auth, secretStore, connection: plan};
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

