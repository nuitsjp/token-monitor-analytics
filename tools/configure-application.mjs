import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {readJSON,readEnvironment,writeChanged} from './publish-config.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const loopback = host => host === '127.0.0.1' || host === '::1';
const validHost = host => typeof host === 'string' && isIP(host) !== 0;
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;

function environmentText(env) {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid environment assignment.');
    if (value.includes('\\') || value.includes('\n') || value.includes('\r')) throw new Error('Environment values contain unsupported characters.');
    const quote = value.includes("'") ? '"' : "'";
    if (value.includes(quote)) throw new Error('Environment values contain unsupported quotes.');
    return `${key}=${quote}${value}${quote}`;
  }).join('\n') + '\n';
}

function existingEnvironment(filename) {
  try { return readEnvironment(filename); } catch (error) {
    if (error?.code === 'ENOENT') return Object.create(null);
    throw error;
  }
}

function chooseIdentity({identity = {}, listenHost, viewerMode, publicOrigin, port}) {
  const oldTailnet = identity.tailnetIP;
  const host = listenHost ?? identity.listenHost ?? (oldTailnet && !viewerMode?.includes('loopback') ? oldTailnet : '127.0.0.1');
  if (!validHost(host)) throw new Error('listen host must be an IP literal.');
  const selectedMode = viewerMode ?? identity.viewerMode ?? (oldTailnet && !loopback(host) ? 'tailscale' : 'loopback');
  if (!['loopback', 'basic', 'tailscale'].includes(selectedMode)) throw new Error('viewer mode must be loopback, basic or tailscale.');
  const selectedPort = port ?? identity.port ?? 8788;
  if (!validPort(selectedPort)) throw new Error('Port must be an integer from 1024 through 65535.');
  if (selectedMode === 'loopback' && !loopback(host)) throw new Error('Loopback viewer mode requires a loopback listen host.');
  if (selectedMode === 'tailscale' && (loopback(host) || isIP(host) !== 4 || !host.startsWith('100.'))) throw new Error('Tailscale viewer mode requires a Tailscale IPv4 listen host.');
  const defaultHost = identity.hostname ?? host;
  const origin = publicOrigin ?? identity.publicOrigin ?? `http://${defaultHost.includes(':') && !defaultHost.startsWith('[') ? `[${defaultHost}]` : defaultHost}:${selectedPort}`;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('publicOrigin must be a valid HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('publicOrigin must be an HTTP(S) origin without credentials or path.');
  if (selectedMode === 'loopback' && (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw new Error('Loopback publicOrigin must use HTTP localhost.');
  return {host, mode: selectedMode, port: selectedPort, origin: parsed.origin};
}

/**
 * Write the new-install configuration. The function has no Hub/Collector
 * input by design; Hub rows live in SQLite and are added through the UI.
 */
export function configureApplication({dir, identity = {}, port, listenHost, viewerMode, publicOrigin, databasePath, hubSecretsPath, update, management} = {}) {
  if (!dir) throw new Error('Configuration directory is required.');
  const directory = path.resolve(dir);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = name => path.join(directory, name);
  const oldConfig = fs.existsSync(file('analytics.json')) ? readJSON(file('analytics.json')) : {};
  const selected = chooseIdentity({identity, port, listenHost, viewerMode, publicOrigin});
  const productionDirectory = directory === path.resolve('/var/lib/tma-deploy/config');
  const dbPath = path.resolve(databasePath ?? (productionDirectory ? '/var/lib/tma-analytics/analytics.db' : path.join(directory, 'analytics.db')));
  const secretPath = path.resolve(hubSecretsPath ?? (productionDirectory ? '/var/lib/tma-analytics/hub-secrets.json' : path.join(directory, 'hub-secrets.json')));
  const oldEnv = existingEnvironment(file('analytics.env'));
  const basicEnv = Object.create(null);
  if (selected.mode === 'basic') {
    basicEnv.TMA_VIEWER_USER = oldEnv.TMA_VIEWER_USER ?? 'viewer';
    basicEnv.TMA_VIEWER_PASSWORD = oldEnv.TMA_VIEWER_PASSWORD ?? randomBytes(24).toString('hex');
  }
  const oldUpdate = oldConfig.update && typeof oldConfig.update === 'object' ? oldConfig.update : {};
  const updateConfig = update ?? {
    enabled: oldUpdate.enabled ?? true,
    repositoryUrl: oldUpdate.repositoryUrl ?? 'https://github.com/nuitsjp/token-monitor-analytics.git',
    branch: oldUpdate.branch ?? 'main',
    checkIntervalSeconds: oldUpdate.checkIntervalSeconds ?? 300
  };
  const config = {
    version: 2,
    listen: {host: selected.host, port: selected.port},
    publicOrigin: selected.origin,
    databasePath: dbPath,
    timeZone: typeof oldConfig.timeZone === 'string' ? oldConfig.timeZone : 'Asia/Tokyo',
    detailRetentionDays: Number.isInteger(oldConfig.detailRetentionDays) ? oldConfig.detailRetentionDays : 7,
    hubSecretsPath: secretPath,
    viewerAuth: selected.mode === 'basic' ? {mode: 'basic', userEnv: 'TMA_VIEWER_USER', passwordEnv: 'TMA_VIEWER_PASSWORD'} : {mode: selected.mode},
    management: {enabled: management ?? oldConfig.management?.enabled ?? true},
    contracts: Array.isArray(oldConfig.contracts) ? oldConfig.contracts : [],
    update: updateConfig,
    demo: false
  };
  const connection = {
    version: 2,
    listen: config.listen,
    publicOrigin: config.publicOrigin,
    viewerMode: selected.mode
  };
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true, mode: 0o700});
    fs.closeSync(fs.openSync(dbPath, 'wx', 0o600));
  }
  if (!fs.existsSync(secretPath)) {
    fs.mkdirSync(path.dirname(secretPath), {recursive: true, mode: 0o700});
    writeChanged(secretPath, json({schemaVersion: 1, secrets: {}}), 0o600);
  } else if (process.platform !== 'win32') {
    fs.chmodSync(secretPath, 0o600);
  }
  let changed = false;
  changed = writeChanged(file('analytics.json'), json(config), 0o600) || changed;
  changed = writeChanged(file('analytics.env'), environmentText(basicEnv), 0o600) || changed;
  changed = writeChanged(file('connection.json'), json(connection), 0o600) || changed;
  return {ready: true, changed, publicOrigin: config.publicOrigin, listen: config.listen, viewerMode: selected.mode};
}

