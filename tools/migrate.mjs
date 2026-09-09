/*
 * One-time migration from the Go Collector/HTTP bridge installation to the
 * single Node application.  This file is intentionally the only place that
 * knows how to read the legacy config, start the pinned legacy server, or
 * drain the legacy outbox.  Normal Analytics code must never import it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {
  createPinnedSourceSnapshot,
  assertPinnedSource,
  verifyReleaseArtifact,
  withPublicationLock,
  releaseContentHash,
  runReleaseVerification,
} from './release.mjs';

export const LEGACY_COMMIT_SHA = 'cae687c4947990e9da6db3193ea8afe26b4b5246';
export const MIGRATION_STATE_VERSION = 1;
export const MIGRATION_PHASES = Object.freeze([
  'prepare', 'stop', 'drain', 'finalbackup', 'archive', 'provision', 'publish', 'complete'
]);
const PHASE_INDEX = new Map(MIGRATION_PHASES.map((value, index) => [value, index]));
const UPDATE_RUNNING_STATES = new Set(['accepted', 'running', 'stopping', 'deploying', 'restarting', 'verifying']);
const DEFAULT_TARGET_REPOSITORY = 'https://github.com/nuitsjp/token-monitor-analytics.git';
const DEFAULT_TARGET_CONFIG_DIR = '/var/lib/tma-deploy/config';

function defaultTargetConfigDir() {
  if (process.platform !== 'win32') return DEFAULT_TARGET_CONFIG_DIR;
  return path.join(process.env.ProgramData ?? path.dirname(os.homedir()), 'token-monitor-analytics', 'config');
}

function errorWithCode(message, code, extra = {}) {
  return Object.assign(new Error(message), {code, ...extra});
}

function fullSha(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw errorWithCode(`${label} must be a full 40-character commit SHA`, 'invalid_sha');
  }
  return value.toLowerCase();
}

function regularFile(filename, label = 'file') {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) {
    if (error?.code === 'ENOENT') throw errorWithCode(`${label} is missing`, 'missing_file');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw errorWithCode(`${label} must be a regular file`, 'invalid_file');
  return stat;
}

function optionalRegular(filename) {
  try { return regularFile(filename); } catch (error) {
    if (error?.code === 'missing_file') return null;
    throw error;
  }
}

function absolute(filename, base = process.cwd()) {
  if (typeof filename !== 'string' || !filename.trim()) throw errorWithCode('A path is required', 'invalid_path');
  return path.resolve(base, filename);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(filename) {
  return sha256(fs.readFileSync(filename));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function readJson(filename, label, maxBytes = 1024 * 1024) {
  const stat = regularFile(filename, label);
  if (stat.size > maxBytes) throw errorWithCode(`${label} is too large`, 'invalid_file');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw errorWithCode(`${label} is invalid JSON`, 'invalid_file'); }
}

function writeAtomic(filename, content, mode = 0o600) {
  const target = absolute(filename);
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.migration-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
  try {
    const parent = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch {}
  return target;
}

/** Atomically persist the non-secret, monotonic migration state. */
export function saveMigrationState(filename, state) {
  const next = {
    schemaVersion: MIGRATION_STATE_VERSION,
    ...state,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  const phase = next.phase ?? 'prepare';
  if (!PHASE_INDEX.has(phase)) throw errorWithCode('Migration state has an invalid phase', 'invalid_state');
  writeAtomic(filename, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export function loadMigrationState(filename) {
  try {
    const state = readJson(filename, 'Migration state', 1024 * 1024);
    if (!state || state.schemaVersion !== MIGRATION_STATE_VERSION || !PHASE_INDEX.has(state.phase)) throw errorWithCode('Migration state is invalid', 'invalid_state');
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'missing_file') return null;
    throw error;
  }
}

function nextState(state, phase, extra = {}) {
  if (!PHASE_INDEX.has(phase)) throw errorWithCode('Unknown migration phase', 'invalid_state');
  if (state && PHASE_INDEX.get(phase) < PHASE_INDEX.get(state.phase)) throw errorWithCode('Migration phases cannot move backwards', 'invalid_state');
  return {...state, phase, ...extra, updatedAt: new Date().toISOString()};
}

function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'migration_failed';
  return {code, message: error?.message && !/[\r\n]/.test(error.message) ? error.message.slice(0, 240) : 'Migration failed'};
}

// Platform hooks are injected in isolated tests and may return their whole
// context.  Never let a hook accidentally persist the in-memory legacy token,
// environment, or Secret values in the resumable state file.
function safeStateValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => safeStateValue(item, seen)).filter(item => item !== undefined);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'legacy' || key === 'environment' || key === 'token' || key === 'secret' || key === 'secrets' || /password/i.test(key)) continue;
    const safe = safeStateValue(item, seen);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function resolveRelative(configFile, value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return path.resolve(path.dirname(configFile), fallback);
  return path.resolve(path.dirname(configFile), value);
}

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value); }

const LEGACY_SECRET_FIELDS = new Set(['secret', 'token', 'apiKey', 'api_key', 'hubSecret', 'secretValue', 'secret_value']);

function publicLegacyHub(hub) {
  return Object.fromEntries(Object.entries(hub ?? {}).filter(([key]) => !LEGACY_SECRET_FIELDS.has(key) && (!/(secret|token|password|api.?key)/i.test(key) || /_env$/i.test(key))));
}

function readLegacyHubs(analyticsConfig, analyticsFile, collectorConfig, collectorFile) {
  const byId = new Map();
  const add = hub => {
    if (!hub || !validId(hub.id)) return;
    const current = byId.get(hub.id) ?? {id: hub.id, label: hub.id};
    byId.set(hub.id, {
      ...current,
      ...publicLegacyHub(Object.fromEntries(Object.entries(hub).filter(([, value]) => value !== undefined))),
      label: String(hub.label ?? current.label ?? hub.id),
    });
  };
  for (const hub of Array.isArray(analyticsConfig.hubs) ? analyticsConfig.hubs : []) add(hub);
  for (const hub of Array.isArray(collectorConfig.hubs) ? collectorConfig.hubs : []) add(hub);

  let hubsFile = null;
  let secretsFile = null;
  if (typeof analyticsConfig.hubsPath === 'string' && analyticsConfig.hubsPath.trim()) {
    const hubsPath = resolveRelative(analyticsFile, analyticsConfig.hubsPath);
    const raw = readJson(hubsPath, 'Legacy Hub configuration', 262144);
    if (!Array.isArray(raw.hubs)) throw errorWithCode('Legacy Hub configuration has no hubs array', 'invalid_legacy_config');
    hubsFile = hubsPath;
    for (const hub of raw.hubs) add(hub);
    const secretPath = resolveRelative(hubsPath, raw.secretsPath, 'hub-secrets.json');
    secretsFile = secretPath;
    if (!optionalRegular(secretPath)) throw errorWithCode('Legacy Hub Secret file is missing', 'invalid_legacy_config');
  }
  for (const hub of Array.isArray(collectorConfig.hubs) ? collectorConfig.hubs : []) add(hub);
  return {hubs: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), hubsFile, secretsFile};
}

function parseLegacyLayout({analyticsConfigPath, collectorConfigPath, analyticsEnvPath = null, collectorEnvPath = null, environment = process.env} = {}) {
  const analyticsFile = absolute(analyticsConfigPath);
  const collectorFile = absolute(collectorConfigPath);
  const resolvedAnalyticsEnvPath = absolute(analyticsEnvPath ?? path.join(path.dirname(analyticsFile), 'analytics.env'));
  const resolvedCollectorEnvPath = absolute(collectorEnvPath ?? path.join(path.dirname(collectorFile), 'collector.env'));
  const analytics = readJson(analyticsFile, 'Legacy Analytics configuration', 262144);
  const collector = readJson(collectorFile, 'Legacy Collector configuration', 262144);
  if (analytics.version !== 1) throw errorWithCode('Legacy Analytics configuration must be version 1', 'invalid_legacy_config');
  if (collector.version !== 1) throw errorWithCode('Legacy Collector configuration must be version 1', 'invalid_legacy_config');
  if (analytics.demo === true || collector.demo === true) throw errorWithCode('Demo configuration cannot be migrated into the real database', 'demo_database');
  const databasePath = resolveRelative(analyticsFile, analytics.databasePath, 'analytics.db');
  const outboxPath = resolveRelative(collectorFile, collector.spool_dir, './data/outbox');
  const ingestEnv = collector.ingest_token_env;
  if (typeof ingestEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ingestEnv)) throw errorWithCode('Legacy Collector ingest token name is invalid', 'invalid_legacy_config');
  const analyticsIngestEnv = analytics.ingestTokenEnv;
  if (typeof analyticsIngestEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(analyticsIngestEnv)) {
    throw errorWithCode('Legacy Analytics ingest token name is invalid', 'invalid_legacy_config');
  }
  const runtimeEnvironment = loadLegacyEnvironment({analyticsEnvPath: resolvedAnalyticsEnvPath, collectorEnvPath: resolvedCollectorEnvPath, environment});
  const token = runtimeEnvironment[ingestEnv];
  if (typeof token !== 'string' || token.length < 1 || /[\r\n\0]/.test(token)) throw errorWithCode('Legacy Collector ingest token is unavailable', 'missing_legacy_secret');
  if (runtimeEnvironment[analyticsIngestEnv] !== token) throw errorWithCode('Legacy Analytics and Collector ingest credentials do not match', 'legacy_ingest_mismatch');
  const hubs = readLegacyHubs(analytics, analyticsFile, collector, collectorFile);
  const contracts = Array.isArray(analytics.contracts) ? analytics.contracts : [];
  const hubIds = [...new Set([...hubs.hubs.map(hub => hub.id), ...contracts.map(contract => contract?.hubId)].filter(validId))].sort();
  if (!hubIds.length && !Array.isArray(analytics.hubs) && !analytics.hubsPath) throw errorWithCode('Legacy Hub registration is missing', 'invalid_legacy_config');
  return {
    analyticsFile, collectorFile, analyticsEnvPath: resolvedAnalyticsEnvPath, collectorEnvPath: resolvedCollectorEnvPath,
    analytics, collector, databasePath, outboxPath,
    ingestEnv, token, environment: runtimeEnvironment, hubs: hubs.hubs, hubsFile: hubs.hubsFile, secretsFile: hubs.secretsFile,
    contracts, hubIds,
    fingerprint: sha256(stable({
      analytics: fileSha256(analyticsFile), collector: fileSha256(collectorFile),
      analyticsEnv: optionalRegular(resolvedAnalyticsEnvPath) ? fileSha256(resolvedAnalyticsEnvPath) : null,
      collectorEnv: optionalRegular(resolvedCollectorEnvPath) ? fileSha256(resolvedCollectorEnvPath) : null,
      hubs: hubs.hubsFile ? fileSha256(hubs.hubsFile) : null,
      secrets: hubs.secretsFile && optionalRegular(hubs.secretsFile) ? fileSha256(hubs.secretsFile) : null,
      databasePath, outboxPath,
    })),
  };
}

function legacyDescriptor(legacy) {
  return {
    analyticsFile: legacy.analyticsFile, collectorFile: legacy.collectorFile,
    analyticsEnvPath: legacy.analyticsEnvPath, collectorEnvPath: legacy.collectorEnvPath,
    analytics: {
      timeZone: legacy.analytics.timeZone,
      detailRetentionDays: legacy.analytics.detailRetentionDays,
      listen: legacy.analytics.listen,
      publicOrigin: legacy.analytics.publicOrigin,
      viewerAuth: legacy.analytics.viewerAuth,
      tailnetViewer: legacy.analytics.tailnetViewer,
      update: legacy.analytics.update,
    },
    databasePath: legacy.databasePath, outboxPath: legacy.outboxPath,
    ingestEnv: legacy.ingestEnv, hubs: legacy.hubs, hubsFile: legacy.hubsFile,
    secretsFile: legacy.secretsFile, contracts: legacy.contracts, hubIds: legacy.hubIds,
    fingerprint: legacy.fingerprint,
  };
}

function legacyFromDescriptor(descriptor, environment = process.env, {protectedBackup = null} = {}) {
  const tokenEnvironment = loadLegacyEnvironment({
    analyticsEnvPath: descriptor.analyticsEnvPath,
    collectorEnvPath: descriptor.collectorEnvPath,
    environment,
    fallbackAnalyticsEnvPath: protectedBackup ? path.join(protectedBackup, 'legacy-analytics-env') : null,
    fallbackCollectorEnvPath: protectedBackup ? path.join(protectedBackup, 'legacy-collector-env') : null,
  });
  const token = typeof tokenEnvironment[descriptor.ingestEnv] === 'string' ? tokenEnvironment[descriptor.ingestEnv] : '';
  return {
    ...descriptor,
    token, environment: tokenEnvironment,
    collector: {version: 1, ingest_token_env: descriptor.ingestEnv},
  };
}

function classifyOutbox(directory) {
  const result = {directory, json: [], unknown: [], temporary: [], corrupt: [], safe: true};
  if (!fs.existsSync(directory)) return result;
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw errorWithCode('Legacy outbox is not a regular directory', 'outbox_unsafe');
    }
  } catch (error) {
    if (error?.code === 'outbox_unsafe') throw error;
    throw errorWithCode('Legacy outbox cannot be read', 'outbox_unreadable');
  }
  let entries;
  try { entries = fs.readdirSync(directory).sort(); } catch { throw errorWithCode('Legacy outbox cannot be read', 'outbox_unreadable'); }
  for (const name of entries) {
    const filename = path.join(directory, name);
    let stat;
    try { stat = fs.lstatSync(filename); } catch { result.unknown.push(name); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { result.unknown.push(name); continue; }
    if (name.startsWith('.tmp-')) { result.temporary.push(name); continue; }
    if (!name.endsWith('.json')) { result.unknown.push(name); continue; }
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
      result.json.push(name);
    } catch { result.corrupt.push(name); }
  }
  result.safe = result.unknown.length === 0 && result.temporary.length === 0 && result.corrupt.length === 0;
  return result;
}

function serviceUnitCandidates(home = null) {
  const units = ['tma-collector.service', 'tma-analytics.service', 'tma-update.service'];
  const systemDirectory = '/etc/systemd/system';
  const result = units.flatMap(name => [
    path.join(systemDirectory, name),
    path.join(systemDirectory, `${name}.d`),
    path.join(systemDirectory, 'multi-user.target.wants', name),
  ]);
  if (home) {
    const userDirectory = path.join(home, '.config/systemd/user');
    result.push(...units.flatMap(name => [
      path.join(userDirectory, name),
      path.join(userDirectory, `${name}.d`),
      path.join(userDirectory, 'default.target.wants', name),
    ]));
  }
  return result;
}

function publicationHome(options) {
  if (options.publicationHome) return absolute(options.publicationHome);
  const username = options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER;
  if (!username || process.platform !== 'linux') return null;
  try { return execFileSync('/usr/bin/getent', ['passwd', username], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split(':')[5] || null; }
  catch { return null; }
}

function knownPathSources({legacy, options, home = null} = {}) {
  const codeRoot = options.legacyCodeRoot ?? options.currentDir ?? '/opt/token-monitor-analytics/current';
  let resolvedCode = null;
  try { resolvedCode = fs.realpathSync(codeRoot); } catch {}
  const sources = [
    {key: 'legacy-analytics-config', path: legacy.analyticsFile},
    {key: 'legacy-collector-config', path: legacy.collectorFile},
    {key: 'legacy-analytics-env', path: options.analyticsEnvPath ?? path.join(path.dirname(legacy.analyticsFile), 'analytics.env')},
    {key: 'legacy-collector-env', path: options.collectorEnvPath ?? path.join(path.dirname(legacy.collectorFile), 'collector.env')},
    {key: 'legacy-hubs', path: legacy.hubsFile},
    {key: 'legacy-hub-secrets', path: legacy.secretsFile},
    {key: 'legacy-database', path: legacy.databasePath},
    {key: 'legacy-outbox', path: legacy.outboxPath},
    {key: 'legacy-code', path: codeRoot},
    {key: 'legacy-code-target', path: resolvedCode && resolvedCode !== path.resolve(codeRoot) ? resolvedCode : null},
    {key: 'legacy-runner', path: options.legacyRunnerDir ?? '/var/lib/tma-deploy/updater'},
    {key: 'legacy-fixed-node', path: options.legacyNodePath ?? '/var/lib/tma-deploy/updater/node'},
    {key: 'legacy-root-infrastructure', path: options.infrastructurePath ?? '/etc/token-monitor-analytics/infrastructure.json'},
    {key: 'legacy-publication', path: options.publicationPath ?? '/opt/token-monitor-analytics/publication.json'},
    {key: 'legacy-update-state', path: options.updateStatePath ?? '/var/lib/tma-deploy/update-state.json'},
    ...serviceUnitCandidates(home).map((file, index) => ({key: `legacy-service-${index}`, path: file})),
  ];
  for (const directory of options.legacyDropInDirs ?? []) sources.push({key: `legacy-dropin-${sources.length}`, path: directory});
  return sources.filter(item => typeof item.path === 'string' && item.path.trim()).map(item => ({...item, path: absolute(item.path)}));
}

function readUpdateState(filename) {
  if (!filename || !fs.existsSync(filename)) return null;
  try { return readJson(filename, 'Update state', 256 * 1024); }
  catch { throw errorWithCode('Update state is unreadable; migration was not started', 'update_state_invalid'); }
}

function systemctlArgs(scope, args, options = {}) {
  if (scope === 'user' && process.platform === 'linux' && process.getuid?.() === 0 && options.publicationUser && options.publicationUser !== 'root') {
    const uid = publicationUserId(options.publicationUser);
    const runtime = `/run/user/${uid}`;
    return {command: '/usr/sbin/runuser', args: ['-u', options.publicationUser, '--', '/usr/bin/env', `XDG_RUNTIME_DIR=${runtime}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus`, '/usr/bin/systemctl', '--user', ...args]};
  }
  return {command: '/usr/bin/systemctl', args: scope === 'user' ? ['--user', ...args] : args};
}

function defaultInspectServices(options = {}) {
  const inspect = scope => name => {
    const command = systemctlArgs(scope, ['show', '--property=LoadState,ActiveState,SubState,MainPID,UnitFileState', name], options);
    let raw;
    try { raw = execFileSync(command.command, command.args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (error) { throw errorWithCode(`Cannot inspect ${scope} service state`, 'service_inspection_failed', {cause: error}); }
    const fields = Object.fromEntries(raw.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s)).filter(parts => parts.length === 2));
    if (!fields.LoadState) throw errorWithCode(`Cannot inspect ${scope} service state`, 'service_inspection_failed');
    return {
      scope, unit: name, loadState: fields.LoadState, active: fields.ActiveState === 'active',
      subState: fields.SubState ?? 'unknown', pid: Number(fields.MainPID) || 0,
      enabled: fields.UnitFileState === 'enabled',
    };
  };
  return ['tma-collector.service', 'tma-analytics.service', 'tma-update.service'].flatMap(name => [inspect('user')(name), inspect('system')(name)]);
}

function defaultServices(scope, action, unit, extra = [], options = {}) {
  const command = systemctlArgs(scope, [action, ...extra, ...(unit ? [unit] : [])], options);
  try { execFileSync(command.command, command.args, {stdio: 'ignore'}); }
  catch { throw errorWithCode(`Cannot ${action} the legacy service`, 'service_command_failed'); }
}

function publicationUserId(username) {
  if (Number.isSafeInteger(username)) return username;
  if (typeof username !== 'string' || !username) throw errorWithCode('A publication user is required for the privileged handoff', 'privilege_required');
  try {
    const fields = execFileSync('/usr/bin/getent', ['passwd', username], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split(':');
    const uid = Number(fields[2]);
    if (!Number.isSafeInteger(uid) || uid < 1000) throw new Error('invalid uid');
    return uid;
  } catch { throw errorWithCode('The configured publication user is unavailable', 'privilege_required'); }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function comparableProcessText(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

/**
 * A PID persisted across a crash/reboot is only a hint.  Before an automatic
 * retry or restore is allowed to terminate it, prove that it is the Node
 * process launched from this migration's application directory and config.
 * An operator-supplied --analytics-pid remains an explicit stop instruction,
 * but a state-file PID must fail closed when the OS cannot identify it.
 */
function ownsPublishedProcess(pid, {installDir, configPath} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof installDir !== 'string' || typeof configPath !== 'string') return false;
  if (!processExists(pid)) return false;
  const expectedInstall = comparableProcessText(path.resolve(installDir));
  const expectedConfig = comparableProcessText(path.resolve(configPath));
  if (!expectedInstall || !expectedConfig) return false;
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';$env:PSModulePath=(Join-Path $PSHOME 'Modules');$module=Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1';if (Test-Path $module) { Import-Module $module -Force -ErrorAction Stop };$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\";if ($null -ne $p) { $p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress }`;
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    try {
      const raw = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        env: {...process.env, PSModulePath: `${process.env.SystemRoot ?? ''}\\System32\\WindowsPowerShell\\v1.0\\Modules`},
        timeout: 5000, killSignal: 'SIGTERM', windowsHide: true,
      }).trim();
      if (!raw) return false;
      const row = JSON.parse(raw);
      const executable = comparableProcessText(row.ExecutablePath);
      const command = comparableProcessText(row.CommandLine);
      const expectedExecutable = comparableProcessText(process.execPath);
      return Boolean(executable && command && (executable === expectedExecutable || path.basename(executable) === path.basename(expectedExecutable))
        && command.includes(expectedInstall) && command.includes(expectedConfig) && command.includes('/analytics/runtime/server.mjs'));
    } catch { return false; }
  }
  // The Linux path is also useful in isolated tests and makes the same
  // ownership rule observable without pretending that a PID is durable.
  try {
    const executable = comparableProcessText(fs.realpathSync(`/proc/${pid}/exe`));
    const command = comparableProcessText(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '));
    const expectedExecutable = comparableProcessText(fs.realpathSync(process.execPath));
    return Boolean(executable && command && executable === expectedExecutable
      && command.includes(expectedInstall) && command.includes(expectedConfig) && command.includes('/analytics/runtime/server.mjs'));
  } catch { return false; }
}

async function stopProcessByPid(pid, label) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw errorWithCode(`A valid ${label} PID is required`, 'windows_stop_verification_required');
  if (!processExists(pid)) return {pid, alreadyStopped: true};
  try { process.kill(pid, 'SIGTERM'); } catch (error) { throw errorWithCode(`Cannot stop the Windows ${label} process`, 'windows_stop_failed', {cause: error}); }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return {pid, stopped: true};
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw errorWithCode(`Windows ${label} process did not stop after SIGTERM`, 'service_still_running');
}

function windowsDatabaseProbe(databasePath) {
  if (!databasePath || !fs.existsSync(databasePath)) return true;
  const probe = `${databasePath}.migration-probe-${process.pid}`;
  try {
    fs.renameSync(databasePath, probe);
    fs.renameSync(probe, databasePath);
    return true;
  } catch (error) {
    try { if (fs.existsSync(probe) && !fs.existsSync(databasePath)) fs.renameSync(probe, databasePath); } catch {}
    throw errorWithCode('A Windows process still has the legacy database open', 'database_writer_still_running', {cause: error});
  } finally { fs.rmSync(probe, {force: true}); }
}

function parseEnvironmentFile(filename, label = 'Environment') {
  if (!filename || !fs.existsSync(filename)) return {};
  regularFile(filename, label);
  const result = {};
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw errorWithCode('Analytics environment contains an invalid assignment', 'target_credentials_invalid');
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/\0|\r|\n/.test(value)) throw errorWithCode('Analytics environment contains an invalid value', 'target_credentials_invalid');
    result[match[1]] = value;
  }
  return result;
}

/**
 * Load the environment visible to the pinned Analytics process.  A service
 * launched by systemd gets both files even when the migration CLI is entered
 * through sudo, so relying on process.env alone would drain with the wrong
 * token.  Explicit CLI/inherited values take precedence over file values;
 * conflicting file values fail closed unless an explicit value resolves the
 * conflict.  The merged object stays in memory and is never persisted.
 */
function loadLegacyEnvironment({analyticsEnvPath, collectorEnvPath, environment = process.env, fallbackAnalyticsEnvPath = null, fallbackCollectorEnvPath = null} = {}) {
  const analyticsPath = (analyticsEnvPath && fs.existsSync(analyticsEnvPath)) ? analyticsEnvPath : fallbackAnalyticsEnvPath;
  const collectorPath = (collectorEnvPath && fs.existsSync(collectorEnvPath)) ? collectorEnvPath : fallbackCollectorEnvPath;
  const analyticsValues = parseEnvironmentFile(analyticsPath, 'Legacy Analytics environment');
  const collectorValues = parseEnvironmentFile(collectorPath, 'Legacy Collector environment');
  const explicit = {};
  if (environment && typeof environment === 'object') {
    for (const [name, value] of Object.entries(environment)) if (typeof value === 'string') explicit[name] = value;
  }
  for (const [name, value] of Object.entries(collectorValues)) {
    if (Object.hasOwn(analyticsValues, name) && analyticsValues[name] !== value && !Object.hasOwn(explicit, name)) {
      throw errorWithCode(`Legacy environment files disagree for ${name}`, 'legacy_env_conflict');
    }
  }
  return {...collectorValues, ...analyticsValues, ...explicit};
}

function copyDirectReleaseTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw errorWithCode('Windows release contains a symbolic link', 'publish_proof_invalid');
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, {recursive: true, mode: stat.mode & 0o777});
    for (const name of fs.readdirSync(source).sort()) copyDirectReleaseTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!stat.isFile()) throw errorWithCode('Windows release contains an unsupported file', 'publish_proof_invalid');
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o7777);
}

async function stopDirectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return {alreadyStopped: true};
  try {
    return await stopProcessByPid(pid, 'published Analytics');
  } catch (error) {
    throw errorWithCode('Published Analytics process did not stop after failed startup proof', 'publish_cleanup_failed', {cause: error});
  }
}

/**
 * Windows has no Ubuntu publication handoff or systemd user manager. It still
 * needs a concrete cutover: install the verified release, launch its real
 * server against the post-drain database, and prove health/state/SSE before
 * the migration can reach `complete`.
 */
export async function publishWindowsMigrationArtifact(context, options = {}) {
  const installDir = absolute(options.windowsInstallDir ?? context.state.windowsInstallDir ?? path.join(path.dirname(context.state.targetConfigPath), 'application'));
  if (path.resolve(installDir) === path.resolve(context.state.targetConfigPath) || path.resolve(installDir) === path.resolve(context.state.targetSecretsPath)) {
    throw errorWithCode('Windows application directory must be separate from migration configuration', 'target_path_invalid');
  }
  const manifestPath = path.join(context.targetArtifact.directory, 'release-manifest.json');
  const manifest = readJson(manifestPath, 'Target release manifest', 65536);
  const existingManifestPath = path.join(installDir, 'release-manifest.json');
  if (fs.existsSync(installDir)) {
    const stat = fs.lstatSync(installDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw errorWithCode('Windows application directory is not a regular directory', 'target_path_invalid');
    if (!fs.existsSync(existingManifestPath)) throw errorWithCode('Windows application directory is not a verified release', 'target_install_conflict');
    const existing = readJson(existingManifestPath, 'Existing Windows release manifest', 65536);
    if (existing.releaseId !== manifest.releaseId || existing.contentHash !== manifest.contentHash || existing.targetCommitSha !== manifest.targetCommitSha) throw errorWithCode('Windows application directory contains another release', 'target_install_conflict');
  } else {
    fs.mkdirSync(path.dirname(installDir), {recursive: true, mode: 0o700});
    const temporary = `${installDir}.migration-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      fs.mkdirSync(temporary, {recursive: true, mode: 0o700});
      copyDirectReleaseTree(context.targetArtifact.directory, temporary);
      fs.renameSync(temporary, installDir);
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  }
  const serverPath = path.join(installDir, 'analytics', 'runtime', 'server.mjs');
  regularFile(serverPath, 'Windows Analytics server');
  regularFile(context.state.targetConfigPath, 'Target Analytics configuration');
  const runtime = await import(pathToFileURL(path.join(installDir, 'analytics/runtime/config.mjs')).href);
  const env = {...(options.environment ?? process.env), ...parseEnvironmentFile(context.state.targetAnalyticsEnvPath)};
  const loaded = runtime.loadConfig(context.state.targetConfigPath);
  const auth = typeof runtime.credentials === 'function' ? runtime.credentials(loaded, env) : {};
  const child = spawn(process.execPath, ['--experimental-strip-types', serverPath, '--config', context.state.targetConfigPath], {
    cwd: installDir, env, stdio: 'ignore', windowsHide: true,
  });
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) throw errorWithCode('Windows Analytics process did not start', 'publish_start_failed');
  let exited = null;
  child.once('exit', (code, signal) => { exited = {code, signal}; });
  child.once('error', error => { exited = {error}; });
  const windowsProcess = {pid, installDir, configPath: path.resolve(context.state.targetConfigPath), status: 'starting'};
  try {
    if (context.statePath) saveMigrationState(context.statePath, {...context.state, windowsProcess});
  } catch (error) {
    await stopDirectProcess(pid);
    throw errorWithCode('Could not persist the Windows Analytics process handoff', 'state_write_failed', {cause: error});
  }
  child.unref();
  try {
    const publication = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish-ubuntu.mjs')).href);
    const health = await publication.defaultHealthCheck({analytics: loaded, auth}, {expectedRelease: manifest, timeoutMs: 15000});
    await new Promise(resolve => setTimeout(resolve, 100));
    if (exited) throw errorWithCode('The Windows Analytics process exited during startup', 'publish_start_failed');
    return {
      direct: true, platform: 'windows', processId: pid, installDir,
      targetCommitSha: manifest.targetCommitSha, releaseId: manifest.releaseId,
      contentHash: manifest.contentHash, archiveSha256: context.targetArtifact.archiveSha256,
      windowsProcess: {...windowsProcess, status: 'running'},
      ...health, lockHeld: true,
    };
  } catch (error) {
    await stopDirectProcess(pid);
    throw errorWithCode('Windows Analytics health proof failed; migration remains resumable before completion', 'publish_health_failed', {cause: error});
  }
}

async function publishVerifiedMigrationArtifact(context, options) {
  const user = options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER;
  const uid = options.publicationUid ?? publicationUserId(user);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-migration-target-source-'));
  let source;
  try {
    source = options.targetSourceRoot
      ? {root: absolute(options.targetSourceRoot)}
      : createPinnedSourceSnapshot({repositoryRoot: options.repositoryRoot ?? process.cwd(), targetCommitSha: context.targetCommitSha, outputDir: sourceDir});
    const publication = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish-ubuntu.mjs')).href);
    const runUser = (_scope, action, unit) => {
      if (process.platform !== 'linux' || process.getuid?.() !== 0 || !user) return defaultServices('user', action, unit, [], options);
      const runtime = `/run/user/${uid}`;
      const command = unit ? [action, unit] : [action];
      const args = ['-u', user, '--', '/usr/bin/env', `XDG_RUNTIME_DIR=${runtime}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus`, '/usr/bin/systemctl', '--user', ...command];
      try { execFileSync('/usr/sbin/runuser', args, {stdio: 'ignore'}); } catch { throw errorWithCode(`Cannot ${action} the new Analytics service`, 'publish_service_failed'); }
    };
    const inspectCurrent = () => defaultInspectServices(options).find(item => item.unit === 'tma-analytics.service' && item.scope === 'user') ?? {active: false, enabled: false};
    const services = {
      isActive: () => Boolean(inspectCurrent().active),
      isEnabled: () => Boolean(inspectCurrent().enabled),
      stop: async unit => runUser('user', 'stop', unit),
      start: async unit => runUser('user', 'start', unit),
      daemonReload: () => runUser('user', 'daemon-reload'),
      installUnit: () => {},
    };
    const configDir = path.dirname(context.state.targetConfigPath);
    const prepared = await publication.preparePublication({
      root: source.root, sourceProof: source, targetCommitSha: context.targetCommitSha,
      artifactPath: context.targetArtifactPath, checksumPath: `${context.targetArtifactPath}.sha256`,
      configDir, current: options.currentDir ?? '/opt/token-monitor-analytics/current',
      publicationPath: options.publicationPath ?? '/opt/token-monitor-analytics/publication.json',
      uid, services, allowLegacyLayout: true,
    });
    const result = await publication.applyPublication(prepared, {
      services, targetCommitSha: context.targetCommitSha, jobId: context.state.runId,
      backupDirectory: path.join(context.backupDir, 'publication'),
      allowLegacyLayout: true,
    });
    return result.proof ?? {targetCommitSha: context.targetCommitSha};
  } finally {
    if (!options.targetSourceRoot) fs.rmSync(sourceDir, {recursive: true, force: true});
  }
}

function defaultPlatform(options) {
  const serviceControl = (action, unit, scope = 'user', extra = []) => defaultServices(scope, action, unit, extra, options);
  const serviceRows = layout => layout.services.filter(item => item.scope && item.unit);
  const serviceRunning = item => Boolean(item?.active || item?.pid > 0 || ['activating', 'deactivating'].includes(item?.subState));
  const windows = process.platform === 'win32';
  return {
    now: () => new Date().toISOString(),
    inspectServices: async () => windows ? (options.windowsServices ?? []) : defaultInspectServices(options),
    updateState: () => readUpdateState(options.updateStatePath ?? '/var/lib/tma-deploy/update-state.json'),
    isUpdateActive: () => {
      const update = readUpdateState(options.updateStatePath ?? '/var/lib/tma-deploy/update-state.json');
      if (update && UPDATE_RUNNING_STATES.has(update.status)) return true;
      if (windows) return false;
      return defaultInspectServices(options).some(item => item.unit === 'tma-update.service' && (item.active || item.pid > 0 || ['activating', 'deactivating'].includes(item.subState)));
    },
    stopCollector: async layout => {
      if (windows) {
        if (typeof options.stopWindowsCollector === 'function') return options.stopWindowsCollector(layout);
        const row = layout.services.find(item => item.unit?.toLowerCase().includes('collector') && (item.active || item.pid > 0));
        const pid = options.collectorPid ?? row?.pid;
        if (pid === undefined) {
          if (row) return {alreadyStopped: true};
          throw errorWithCode('Windows migration requires --collector-pid or an inspectable Collector process', 'windows_stop_verification_required');
        }
        return stopProcessByPid(Number(pid), 'Collector');
      }
      for (const service of layout.services.filter(item => item.unit.startsWith('tma-collector') && serviceRunning(item))) defaultServices(service.scope, 'stop', service.unit, [], options);
    },
    stopAnalytics: async layout => {
      if (windows) {
        if (typeof options.stopWindowsAnalytics === 'function') return options.stopWindowsAnalytics(layout);
        const row = layout.services.find(item => item.unit?.toLowerCase().includes('analytics') && (item.active || item.pid > 0));
        const pid = options.analyticsPid ?? row?.pid;
        if (pid === undefined) {
          if (row) return {alreadyStopped: true};
          throw errorWithCode('Windows migration requires --analytics-pid or an inspectable Analytics process', 'windows_stop_verification_required');
        }
        return stopProcessByPid(Number(pid), 'Analytics');
      }
      for (const service of layout.services.filter(item => item.unit.startsWith('tma-analytics') && serviceRunning(item))) defaultServices(service.scope, 'stop', service.unit, [], options);
    },
    inhibitAutostart: async layout => {
      if (windows) {
        if (typeof options.inhibitWindowsAutostart === 'function') return options.inhibitWindowsAutostart(layout);
        const rows = layout.services ?? [];
        if (rows.some(item => item.enabled)) throw errorWithCode('Windows service autostart requires an explicit migration hook', 'windows_autostart_verification_required');
        const pids = [options.collectorPid, options.analyticsPid].filter(value => value !== undefined).map(Number);
        if (!pids.length && !rows.length) throw errorWithCode('Windows migration requires explicit process IDs when no service manager inventory is available', 'windows_autostart_verification_required');
        return {verified: true, managed: false, pids};
      }
      for (const service of serviceRows(layout).filter(item => serviceRunning(item) || item.enabled)) {
        try {
          serviceControl('mask', service.unit, service.scope, ['--runtime']);
          // Inhibit every legacy unit across reboot, including the user
          // Analytics unit: its old code must never open the archived schema
          // if migration is interrupted before provisioning the new unit.
          // provisionForMigration enables only the new Analytics definition.
          serviceControl('disable', service.unit, service.scope);
        } catch { throw errorWithCode('Cannot inhibit legacy service autostart', 'service_command_failed'); }
      }
    },
    verifyStopped: async layout => {
      if (windows) {
        if (typeof options.verifyWindowsStopped === 'function') return options.verifyWindowsStopped(layout);
        const pids = [options.collectorPid, options.analyticsPid].filter(value => value !== undefined).map(Number);
        if (pids.some(processExists)) throw errorWithCode('A Windows legacy process is still running', 'service_still_running');
        const active = (layout.services ?? []).filter(item => (item.active || item.pid > 0) && item.unit?.toLowerCase().includes('tma-'));
        if (active.length) throw errorWithCode('Windows service state still reports a legacy process', 'service_still_running');
        if (!pids.length && !layout.services.length) throw errorWithCode('Windows stop verification requires a PID or service status', 'windows_stop_verification_required');
        return true;
      }
      const current = defaultInspectServices(options).filter(item => (item.active || item.pid > 0 || ['activating', 'deactivating'].includes(item.subState)) && ['tma-collector.service', 'tma-analytics.service'].includes(item.unit));
      if (current.length) throw errorWithCode('A legacy service is still running', 'service_still_running', {services: current});
      return true;
    },
    verifyNoDatabaseWriter: async ({databasePath}) => {
      if (windows) {
        if (typeof options.verifyWindowsDatabaseClosed === 'function') return options.verifyWindowsDatabaseClosed({databasePath});
        return windowsDatabaseProbe(databasePath);
      }
      if (!databasePath) return true;
      const target = path.resolve(databasePath);
      const targets = new Set([target, `${target}-wal`, `${target}-shm`]);
      try {
        const real = fs.realpathSync(target);
        targets.add(real); targets.add(`${real}-wal`); targets.add(`${real}-shm`);
      } catch {}
      const writers = [];
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        const fdDir = `/proc/${name}/fd`;
        let descriptors;
        try { descriptors = fs.readdirSync(fdDir); } catch { continue; }
        for (const fd of descriptors) {
          let link;
          try { link = fs.readlinkSync(path.join(fdDir, fd)); } catch { continue; }
          if (targets.has(link)) { writers.push(Number(name)); break; }
        }
      }
      if (writers.length) throw errorWithCode('A process still has the legacy database open', 'database_writer_still_running');
      return true;
    },
    provision: async context => {
      if (windows) return {platform: 'windows', directCutover: true, targetConfigPath: context.state.targetConfigPath, lockHeld: true};
      if (process.platform !== 'linux' || process.getuid?.() !== 0) throw errorWithCode('Provisioning requires an explicit root phase handoff', 'privilege_required');
      const module = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'provision-ubuntu.mjs')).href);
      if (typeof module.provisionForMigration !== 'function') throw errorWithCode('The installed provision tool cannot accept the migration lock handoff', 'provision_required');
      const provisioned = await module.provisionForMigration({username: options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER, lock: context.lock});
      const uid = provisioned.uid;
      const gid = Number(execFileSync('/usr/bin/getent', ['passwd', options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER], {encoding: 'utf8'}).trim().split(':')[3]);
      for (const filename of [context.state.targetConfigPath, context.state.targetSecretsPath, context.state.targetAnalyticsEnvPath, context.legacy.databasePath]) {
        if (fs.existsSync(filename)) { fs.chownSync(filename, uid, gid); fs.chmodSync(filename, 0o600); }
      }
      return provisioned;
    },
    configure: async context => {
      const targetRuntime = await import(pathToFileURL(path.join(context.targetArtifact.directory, 'analytics/runtime/config.mjs')).href);
      const loaded = targetRuntime.loadConfig(targetConfigPathValue(context.state));
      if (loaded.contracts.length !== 0 || loaded.databasePath !== path.resolve(context.legacy.databasePath)) throw errorWithCode('Target configuration verification failed', 'configuration_failed');
      return {configured: true, targetConfig: loaded.configFile};
    },
    publish: async context => {
      if (windows) return publishWindowsMigrationArtifact(context, options);
      if (process.platform !== 'linux' || process.getuid?.() === 0) {
        // The Ubuntu publisher deliberately runs as the configured ordinary
        // user.  The migration itself keeps the lock while this callback is
        // invoked; use the in-process API so no phase silently unlocks it.
        if (process.platform !== 'linux') throw errorWithCode('Publication requires Ubuntu/systemd', 'publish_required');
      }
      const proof = await publishVerifiedMigrationArtifact(context, options);
      const user = options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER;
      const publicationPath = options.publicationPath ?? '/opt/token-monitor-analytics/publication.json';
      if (process.getuid?.() === 0 && user && fs.existsSync(publicationPath)) {
        const uid = publicationUserId(user);
        const fields = execFileSync('/usr/bin/getent', ['passwd', user], {encoding: 'utf8'}).trim().split(':');
        fs.chownSync(publicationPath, uid, Number(fields[3]));
      }
      return proof;
    },
    preserveCutoverDatabase: async ({databasePath, backupDir}) => {
      const target = path.join(backupDir, `post-cutover-${Date.now()}.db`);
      const sqlite = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../analytics/runtime/sqlite.mjs')).href);
      await sqlite.backupDatabase(databasePath, target);
      return target;
    },
    restoreProtected: async ({manifest, backupRoot}) => {
      for (const entry of manifest.entries ?? []) {
        if (!entry.backedUp) {
          // Provisioning may have created a managed path that did not exist in
          // the legacy inventory (user unit, runner, fixed Node, publication
          // record, or root infrastructure). Remove that new path before
          // restoring the old service layout; otherwise rollback could leave a
          // newly generated unit behind with an old database.
          if (entry.key !== 'legacy-database' && entry.key !== 'legacy-outbox') fs.rmSync(entry.path, {recursive: true, force: true});
          continue;
        }
        if (entry.key === 'legacy-database' || entry.key === 'legacy-outbox') continue;
        const source = path.join(backupRoot, entry.backupKey ?? entry.key);
        if (!fs.existsSync(source)) throw errorWithCode('Protected legacy backup is incomplete', 'restore_unavailable');
        fs.rmSync(entry.path, {recursive: true, force: true});
        copyEntry(source, entry.path, entry.sourceMetadata ?? null);
      }
      return true;
    },
    restoreDatabase: async ({source, destination, metadata}) => {
      const sqlite = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../analytics/runtime/sqlite.mjs')).href);
      await sqlite.backupDatabase(source, destination);
      applyEntryMetadata(destination, metadata);
    },
    stopNew: async ({state} = {}) => {
      if (windows) {
        if (typeof options.stopWindowsAnalytics === 'function') return options.stopWindowsAnalytics();
        const explicitPid = options.analyticsPid;
        const pid = explicitPid ?? state?.published?.processId ?? state?.windowsProcess?.pid;
        if (pid !== undefined) {
          if (explicitPid === undefined) {
            const identity = state?.windowsProcess ?? state?.published ?? {};
            const installDir = identity.installDir;
            const configPath = identity.configPath ?? state?.targetConfigPath;
            if (processExists(Number(pid)) && !ownsPublishedProcess(Number(pid), {installDir, configPath})) throw errorWithCode('The persisted Windows Analytics PID is not identified as the published application', 'windows_process_identity_unknown');
          }
          const result = await stopProcessByPid(Number(pid), 'Analytics');
          const installDir = state?.published?.installDir ?? state?.windowsProcess?.installDir;
          if (installDir && fs.existsSync(installDir)) fs.rmSync(installDir, {recursive: true, force: true});
          return result;
        }
        throw errorWithCode('Windows restore requires the new Analytics PID', 'windows_stop_verification_required');
      }
      const rows = defaultInspectServices(options).filter(item => item.unit === 'tma-analytics.service' && (item.active || item.pid > 0));
      for (const row of rows) defaultServices(row.scope, 'stop', row.unit, [], options);
      const after = defaultInspectServices(options).filter(item => item.unit === 'tma-analytics.service' && (item.active || item.pid > 0 || ['activating', 'deactivating'].includes(item.subState)));
      if (after.length) throw errorWithCode('The new Analytics service is still running', 'service_still_running');
      return true;
    },
    verifyPublished: async ({state} = {}) => {
      if (windows) {
        const pid = state?.published?.processId ?? state?.windowsProcess?.pid;
        const identity = state?.windowsProcess ?? state?.published ?? {};
        if (!ownsPublishedProcess(Number(pid), {installDir: identity.installDir, configPath: identity.configPath ?? state?.targetConfigPath})) throw errorWithCode('The published Windows Analytics process identity is no longer proven', 'publish_proof_invalid');
        return {processId: Number(pid)};
      }
      const current = defaultInspectServices(options).find(item => item.unit === 'tma-analytics.service' && item.scope === 'user');
      if (!current?.active || current.pid <= 0 || !current.enabled) throw errorWithCode('The published Analytics service is not active and enabled', 'publish_proof_invalid');
      return {pid: current.pid};
    },
    startLegacy: async layout => {
      if (windows) {
        if (typeof options.startWindowsLegacy === 'function') return options.startWindowsLegacy(layout);
        if (typeof options.legacyCommand !== 'string' || !options.legacyCommand.trim()) throw errorWithCode('Windows restore requires an explicit legacy launcher command', 'windows_restore_start_required');
        let args = [];
        if (options.legacyArgs !== undefined) {
          try { args = Array.isArray(options.legacyArgs) ? options.legacyArgs : JSON.parse(options.legacyArgs); } catch { throw errorWithCode('Windows legacy launcher arguments must be a JSON array', 'invalid_arguments'); }
          if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw errorWithCode('Windows legacy launcher arguments must be a JSON array', 'invalid_arguments');
        }
        const child = spawn(options.legacyCommand, args, {cwd: options.legacyWorkingDir || undefined, env: options.environment ?? process.env, stdio: 'ignore', windowsHide: true});
        if (!Number.isInteger(child.pid) || child.pid <= 0) throw errorWithCode('Windows legacy launcher did not start', 'windows_restore_start_failed');
        child.unref();
        return {pid: child.pid, command: options.legacyCommand};
      }
      const legacyServices = (layout?.services ?? [])
        .filter(item => ['tma-collector.service', 'tma-analytics.service', 'tma-update.service'].includes(item.unit))
        // Analytics owns the database and must be ready before Collector is
        // allowed to reconnect.  Keep the original scope and active/enabled
        // bits from the protected inventory while imposing that dependency
        // order during rollback.
        .sort((a, b) => {
          const rank = item => item.unit === 'tma-analytics.service' ? 0 : 1;
          return rank(a) - rank(b) || String(a.scope).localeCompare(String(b.scope));
        });
      // Only remove the transient mask for a service that was active or
      // enabled before migration. A loaded-but-disabled legacy system unit is
      // kept disabled and is never revived during rollback.
      const restoreable = legacyServices.filter(item => item.active || item.enabled);
      for (const service of restoreable) {
        try { defaultServices(service.scope, 'unmask', service.unit, [], options); } catch {}
      }
      const scopes = [...new Set(restoreable.map(service => service.scope))];
      for (const scope of scopes) {
        try { defaultServices(scope, 'daemon-reload', null, [], options); } catch {}
      }
      const seen = new Set();
      for (const service of legacyServices.filter(item => (item.active || item.pid > 0) && ['tma-collector.service', 'tma-analytics.service'].includes(item.unit))) {
        const key = `${service.scope}:${service.unit}`;
        if (!seen.has(key)) { defaultServices(service.scope, 'start', service.unit, [], options); seen.add(key); }
      }
      for (const service of legacyServices.filter(item => item.enabled)) {
        const key = `enable:${service.scope}:${service.unit}`;
        if (!seen.has(key)) { defaultServices(service.scope, 'enable', service.unit, [], options); seen.add(key); }
      }
      for (const service of legacyServices.filter(item => !item.enabled && (item.loadState && item.loadState !== 'not-found' || item.active || item.pid > 0))) {
        try { defaultServices(service.scope, 'disable', service.unit, [], options); } catch {}
      }
      return true;
    },
  };
}

function targetConfigPathValue(state) {
  regularFile(state.targetConfigPath, 'Target Analytics configuration');
  return state.targetConfigPath;
}

async function inspectLayout({legacy, options, platform}) {
  const services = await platform.inspectServices();
  const outbox = classifyOutbox(legacy.outboxPath);
  const update = platform.updateState ? await platform.updateState() : readUpdateState(options.updateStatePath);
  if (platform.isUpdateActive && await platform.isUpdateActive()) throw errorWithCode('An update job is active; migration cannot stop it', 'update_conflict');
  if (update && UPDATE_RUNNING_STATES.has(update.status)) throw errorWithCode('An update job is active; migration cannot stop it', 'update_conflict');
  if (!outbox.safe) throw errorWithCode('Legacy outbox contains uncertain or corrupt files; no file was removed', 'outbox_unsafe', {outbox});
  return {
    services, outbox, update,
    layout: services.some(item => item.unit === 'tma-collector.service' && item.active) ? 'legacy-active' : (services.some(item => item.unit === 'tma-analytics.service' && item.active) ? 'legacy-analytics-only' : 'legacy-stopped'),
    classification: {
      legacyCollector: services.some(item => item.unit === 'tma-collector.service'),
      legacyAnalytics: services.some(item => item.unit === 'tma-analytics.service'),
      managedHubs: Boolean(legacy.hubsFile),
      outbox: outbox.json.length ? 'pending' : 'empty',
    },
  };
}

function sourceManifest(sources) {
  return sources.map(source => {
    let stat;
    try { stat = fs.lstatSync(source.path); } catch (error) {
      if (error?.code === 'ENOENT') return {...source, exists: false};
      throw error;
    }
    return {...source, exists: true, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other', size: stat.size, mode: stat.mode & 0o777, digest: stat.isFile() ? fileSha256(source.path) : null};
  });
}

export function inventoryLegacyLayout({legacy, options = {}, inspection, home = null} = {}) {
  const sources = knownPathSources({legacy, options, home});
  return {
    classification: inspection?.classification ?? {},
    layout: inspection?.layout ?? 'unknown',
    services: inspection?.services ?? [],
    outbox: inspection?.outbox ?? classifyOutbox(legacy.outboxPath),
    files: sourceManifest(sources),
    sourceFingerprint: legacy.fingerprint,
  };
}

function ensureNoWebRunnerInvocation(options) {
  if (options.invokedBy === 'web' || options.webRunner === true || process.env.TMA_MIGRATION_INVOKED_BY === 'web') {
    throw errorWithCode('Initial migration must be run by the pinned CLI, not the legacy Web runner', 'web_runner_migration_rejected');
  }
}

function ensureStateInputs(state, {oldCommitSha, targetCommitSha, legacy, targetArtifactPath} = {}) {
  if (!state) return;
  if (state.oldCommitSha !== oldCommitSha || state.targetCommitSha !== targetCommitSha) throw errorWithCode('Migration state belongs to a different pinned revision', 'state_revision_mismatch');
  if (state.sourceFingerprint && state.sourceFingerprint !== legacy.fingerprint) throw errorWithCode('Legacy configuration changed after migration started', 'legacy_inputs_changed');
  if (state.targetArtifact?.path && targetArtifactPath && path.resolve(state.targetArtifact.path) !== path.resolve(targetArtifactPath)) throw errorWithCode('Migration target artifact changed after migration started', 'target_artifact_changed');
}

function assertSafeArtifact({targetArtifactPath, targetCommitSha, verifier = verifyReleaseArtifact, extractDir} = {}) {
  regularFile(targetArtifactPath, 'Target release artifact');
  const verified = verifier({archivePath: targetArtifactPath, expectedTargetCommitSha: targetCommitSha, extractDir});
  if (!verified?.manifest || verified.manifest.targetCommitSha !== targetCommitSha) throw errorWithCode('Target artifact is not a verified full-SHA release', 'target_artifact_invalid');
  return verified;
}

async function verifyTargetGate({targetArtifact, targetCommitSha, options, stageDir, legacy, targetConfigPath, targetSecretsPath} = {}) {
  if (typeof options.verifyTargetRelease === 'function') return options.verifyTargetRelease({targetArtifact, targetCommitSha, legacy});
  if (targetArtifact.manifest.verification?.level !== 'release') throw errorWithCode('Target artifact has not passed the release verification gate', 'target_release_unverified');
  const runtimeContract = targetArtifact.manifest.runtimeContract;
  if (!runtimeContract || typeof runtimeContract.serviceContractVersion !== 'number' || !Array.isArray(runtimeContract.appUnits) || runtimeContract.appUnits.length !== 1 || runtimeContract.appUnits[0] !== 'tma-analytics.service') throw errorWithCode('Target artifact has no compatible single-app runtime contract', 'target_runtime_incompatible');
  const targetSourceDirectory = path.join(stageDir, 'target-source');
  const targetSource = options.targetSourceRoot
    ? {root: absolute(options.targetSourceRoot)}
    : createPinnedSourceSnapshot({repositoryRoot: options.repositoryRoot ?? process.cwd(), targetCommitSha, outputDir: targetSourceDirectory});
  if (releaseContentHash(targetSource.root) !== targetArtifact.manifest.contentHash) throw errorWithCode('Target artifact content does not match the pinned target source', 'target_artifact_source_mismatch');
  // Reuse the exact read-only preparation gate used by the Ubuntu publisher.
  // It verifies the pinned source, artifact content, runner contract, startup
  // configuration and release checks while the legacy process is still live.
  // `applyPublication` remains the only operation allowed to stop/restart the
  // new service later in the publish phase.
  const publication = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish-ubuntu.mjs')).href);
  const gateRoot = path.join(stageDir, 'publication-gate');
  const gateConfigDir = path.join(gateRoot, 'config');
  fs.mkdirSync(gateConfigDir, {recursive: true, mode: 0o700});
  const candidate = targetConfigCandidate({legacy, options, targetConfigPath, targetSecretsPath});
  validateTargetCandidate(candidate, {targetConfigPath, targetSecretsPath, legacy});
  const gateSecretsPath = path.join(gateConfigDir, 'hub-secrets.json');
  const gateConfigPath = path.join(gateConfigDir, 'analytics.json');
  const normalized = {
    ...candidate,
    databasePath: path.resolve(path.dirname(path.resolve(targetConfigPath)), candidate.databasePath),
    hubSecretsPath: gateSecretsPath,
    contracts: [],
  };
  writeAtomic(gateConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
  writeAtomic(gateSecretsPath, `${JSON.stringify({schemaVersion: 1, secrets: {}}, null, 2)}\n`, 0o600);
  const targetEnvPath = targetAnalyticsEnvPath({legacy, options, targetConfigPath});
  const gateEnvPath = path.join(gateConfigDir, 'analytics.env');
  const legacyEnvPath = legacy.analyticsEnvPath ?? options.analyticsEnvPath ?? path.join(path.dirname(legacy.analyticsFile), 'analytics.env');
  const environmentSourcePath = fs.existsSync(targetEnvPath) ? targetEnvPath : (fs.existsSync(legacyEnvPath) ? legacyEnvPath : null);
  if (environmentSourcePath) {
    regularFile(environmentSourcePath, environmentSourcePath === targetEnvPath ? 'Target Analytics environment' : 'Legacy Analytics environment');
    const existingTargetWasV2 = fs.existsSync(targetConfigPath) && readJson(targetConfigPath, 'Target Analytics configuration', 262144).version === 2;
    const content = environmentSourcePath === targetEnvPath && existingTargetWasV2
      ? fs.readFileSync(environmentSourcePath)
      : targetEnvironmentContent(candidate, environmentSourcePath, options.environment ?? process.env);
    fs.writeFileSync(gateEnvPath, content, {flag: 'wx', mode: 0o600});
    fs.chmodSync(gateEnvPath, 0o600);
  } else if (candidate.viewerAuth?.mode === 'basic') {
    const environment = legacy.environment ?? loadLegacyEnvironment({
      analyticsEnvPath: legacy.analyticsEnvPath,
      collectorEnvPath: legacy.collectorEnvPath,
      environment: options.environment ?? process.env,
    });
    const content = `${formatEnvironmentAssignment(candidate.viewerAuth.userEnv, environment[candidate.viewerAuth.userEnv])}\n${formatEnvironmentAssignment(candidate.viewerAuth.passwordEnv, environment[candidate.viewerAuth.passwordEnv])}\n`;
    fs.writeFileSync(gateEnvPath, content, {flag: 'wx', mode: 0o600});
  }
  const services = {isActive: () => false, isEnabled: () => false};
  let releaseChecks = null;
  const prepared = await publication.preparePublication({
    root: gateRoot,
    sourceProof: targetSource,
    targetCommitSha,
    artifactPath: targetArtifact.archivePath,
    checksumPath: targetArtifact.checksumPath,
    configDir: gateConfigDir,
    current: path.join(gateRoot, 'current'),
    publicationPath: path.join(gateRoot, 'publication.json'),
    uid: undefined,
    services,
    allowLegacyLayout: true,
    releaseVerification: {
      assertSource: assertPinnedSource,
      contentHash: releaseContentHash,
      run: (sourceRoot, verificationOptions) => {
        releaseChecks = runReleaseVerification(sourceRoot, verificationOptions);
        return releaseChecks;
      },
    },
  });
  return {targetSourceRoot: targetSource.root, checks: releaseChecks ?? prepared?.manifest?.verification?.checks ?? null, publication: true};
}

function targetConfigCandidate({legacy, options, targetConfigPath, targetSecretsPath}) {
  if (options.targetConfigTemplate) return JSON.parse(JSON.stringify(options.targetConfigTemplate));
  if (targetConfigPath && fs.existsSync(targetConfigPath)) {
    const existing = readJson(targetConfigPath, 'Target Analytics configuration', 262144);
    if (existing.version === 2) return existing;
    // The target path may intentionally be the old analytics.json.  Its
    // version-1 contents are protected before this function replaces them.
  }
  const old = legacy.analytics;
  const oldTailnet = old.tailnetViewer && typeof old.tailnetViewer === 'object' ? old.tailnetViewer : null;
  const inheritedTailnet = oldTailnet && typeof oldTailnet.host === 'string' && Number.isInteger(oldTailnet.port);
  const viewerMode = options.targetViewerMode ?? (inheritedTailnet ? 'tailscale' : (old.viewerAuth?.mode ?? 'loopback'));
  const host = options.targetHost ?? (inheritedTailnet ? oldTailnet.host : (old.listen?.host ?? '127.0.0.1'));
  const port = options.targetPort ?? (inheritedTailnet ? oldTailnet.port : (old.listen?.port ?? 8787));
  const originHost = String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : host;
  const origin = options.targetOrigin ?? (old.publicOrigin ?? `http://${originHost}:${port}`);
  const viewerAuth = viewerMode === 'basic'
    ? {mode: 'basic', userEnv: old.viewerAuth?.userEnv ?? 'TMA_VIEWER_USER', passwordEnv: old.viewerAuth?.passwordEnv ?? 'TMA_VIEWER_PASSWORD'}
    : {mode: viewerMode};
  const oldUpdate = old.update && typeof old.update === 'object' ? old.update : {};
  const inheritedUpdatePath = name => {
    if (oldUpdate[name] === undefined) return undefined;
    if (typeof oldUpdate[name] !== 'string' || !oldUpdate[name].trim()) throw errorWithCode(`Legacy update ${name} is invalid`, 'invalid_legacy_config');
    return path.isAbsolute(oldUpdate[name]) ? path.resolve(oldUpdate[name]) : path.resolve(path.dirname(legacy.analyticsFile), oldUpdate[name]);
  };
  return {
    version: 2,
    listen: {host, port},
    publicOrigin: origin,
    databasePath: legacy.databasePath,
    timeZone: typeof legacy.analytics.timeZone === 'string' ? legacy.analytics.timeZone : 'Asia/Tokyo',
    detailRetentionDays: Number.isInteger(legacy.analytics.detailRetentionDays) ? legacy.analytics.detailRetentionDays : 7,
    hubSecretsPath: targetSecretsPath,
    viewerAuth,
    management: {enabled: true},
    contracts: [],
    update: {
      enabled: oldUpdate.enabled ?? true,
      repositoryUrl: oldUpdate.repositoryUrl ?? DEFAULT_TARGET_REPOSITORY,
      branch: oldUpdate.branch ?? 'main',
      checkIntervalSeconds: oldUpdate.checkIntervalSeconds ?? 300,
      ...(oldUpdate.statePath === undefined ? {} : {statePath: inheritedUpdatePath('statePath')}),
      ...(oldUpdate.repoPath === undefined ? {} : {repoPath: inheritedUpdatePath('repoPath')}),
      ...(oldUpdate.publicationPath === undefined ? {} : {publicationPath: inheritedUpdatePath('publicationPath')}),
    },
    demo: false,
  };
}

function targetAnalyticsEnvPath({legacy, options = {}, targetConfigPath} = {}) {
  return absolute(options.targetAnalyticsEnvPath
    ?? path.join(path.dirname(path.resolve(targetConfigPath)), 'analytics.env'));
}

function formatEnvironmentAssignment(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw errorWithCode('Target Basic-auth environment is unavailable', 'target_credentials_invalid');
  }
  if (/^[^\s'"\\]+$/.test(value)) return `${name}=${value}`;
  if (value.includes('"') || value.includes('\\')) throw errorWithCode('Target Basic-auth environment contains an unsupported character', 'target_credentials_invalid');
  return `${name}="${value}"`;
}

function targetEnvironmentContent(config, sourcePath, environment) {
  if (config.viewerAuth?.mode !== 'basic') return '';
  const fileValues = parseEnvironmentFile(sourcePath, 'Legacy Analytics environment');
  const values = {...fileValues, ...(environment ?? process.env)};
  const user = values[config.viewerAuth.userEnv];
  const password = values[config.viewerAuth.passwordEnv];
  if (typeof user !== 'string' || typeof password !== 'string' || !user || !password) throw errorWithCode('Target Basic-auth environment is unavailable', 'target_credentials_invalid');
  return `${formatEnvironmentAssignment(config.viewerAuth.userEnv, user)}\n${formatEnvironmentAssignment(config.viewerAuth.passwordEnv, password)}\n`;
}

function ensureTargetAnalyticsEnvironment({config, legacy, options, targetConfigPath, targetAnalyticsEnvPath: requestedPath} = {}) {
  const environmentPath = absolute(requestedPath ?? targetAnalyticsEnvPath({legacy, options, targetConfigPath}));
  if (fs.existsSync(environmentPath)) {
    regularFile(environmentPath, 'Target Analytics environment');
    return environmentPath;
  }
  const legacyEnvironmentPath = legacy.analyticsEnvPath ?? options.analyticsEnvPath ?? path.join(path.dirname(legacy.analyticsFile), 'analytics.env');
  if (fs.existsSync(legacyEnvironmentPath) && path.resolve(legacyEnvironmentPath) !== environmentPath) {
    regularFile(legacyEnvironmentPath, 'Legacy Analytics environment');
    return writeAtomic(environmentPath, targetEnvironmentContent(config, legacyEnvironmentPath, options.environment ?? process.env), 0o600);
  }
  if (config.viewerAuth?.mode !== 'basic') return writeAtomic(environmentPath, '', 0o600);
  const environment = options.environment ?? process.env;
  return writeAtomic(environmentPath, targetEnvironmentContent(config, null, environment), 0o600);
}

function validateTargetCandidate(config, {targetConfigPath, targetSecretsPath, legacy} = {}) {
  if (!config || config.version !== 2 || !config.listen || !Array.isArray(config.contracts) || config.contracts.length !== 0) throw errorWithCode('Target configuration must be version 2 with empty active contracts', 'target_config_invalid');
  if (typeof config.listen.host !== 'string' || !Number.isInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65535 || typeof config.publicOrigin !== 'string' || !config.viewerAuth || typeof config.viewerAuth.mode !== 'string') throw errorWithCode('Target listener and viewer boundary are invalid', 'target_config_invalid');
  if (typeof config.databasePath !== 'string' || !config.databasePath.trim() || typeof config.hubSecretsPath !== 'string' || !config.hubSecretsPath.trim()) throw errorWithCode('Target configuration paths are invalid', 'target_config_invalid');
  if (config.hubs !== undefined || config.hubsPath !== undefined || config.ingestTokenEnv !== undefined) throw errorWithCode('Target configuration still contains legacy Hub/ingest registration', 'target_config_legacy');
  const configDirectory = targetConfigPath ? path.dirname(path.resolve(targetConfigPath)) : process.cwd();
  const databasePath = path.resolve(configDirectory, config.databasePath);
  const secretsPath = path.resolve(configDirectory, config.hubSecretsPath);
  if (databasePath !== path.resolve(legacy.databasePath)) throw errorWithCode('Target configuration must use the post-drain database', 'target_database_mismatch');
  if (secretsPath !== path.resolve(targetSecretsPath)) throw errorWithCode('Target configuration Secret path does not match migration target', 'target_secret_mismatch');
  if (targetConfigPath && fs.existsSync(targetConfigPath)) regularFile(targetConfigPath, 'Target Analytics configuration');
}

function writeTargetFiles({legacy, options, targetConfigPath, targetSecretsPath, targetAnalyticsEnvPath: requestedEnvPath} = {}) {
  const existingTargetWasV2 = fs.existsSync(targetConfigPath) && readJson(targetConfigPath, 'Target Analytics configuration', 262144).version === 2;
  const config = targetConfigCandidate({legacy, options, targetConfigPath, targetSecretsPath});
  validateTargetCandidate(config, {targetConfigPath, targetSecretsPath, legacy});
  const target = {...config, databasePath: path.resolve(legacy.databasePath), hubSecretsPath: path.resolve(targetSecretsPath), contracts: []};
  const analyticsEnvPath = ensureTargetAnalyticsEnvironment({config: target, legacy, options, targetConfigPath, targetAnalyticsEnvPath: requestedEnvPath});
  writeAtomic(targetConfigPath, `${JSON.stringify(target, null, 2)}\n`, 0o600);
  if (fs.existsSync(targetSecretsPath)) {
    const current = readJson(targetSecretsPath, 'Target Hub Secret file', 262144);
    if (!current || current.schemaVersion !== 1 || !current.secrets || typeof current.secrets !== 'object') throw errorWithCode('Target Hub Secret file is invalid', 'target_secret_invalid');
    if (Object.keys(current.secrets).length && (existingTargetWasV2 || path.resolve(targetSecretsPath) !== path.resolve(legacy.secretsFile ?? ''))) throw errorWithCode('Target Hub Secret file already contains registrations; migration refuses to clear it', 'target_secret_conflict');
  }
  writeAtomic(targetSecretsPath, `${JSON.stringify({schemaVersion: 1, secrets: {}}, null, 2)}\n`, 0o600);
  return {configPath: targetConfigPath, secretsPath: targetSecretsPath, analyticsEnvPath, config: target};
}

async function validateTargetConfigurationBeforeStop({legacy, targetArtifact, targetConfigPath, targetSecretsPath, stageDir, options} = {}) {
  const candidate = targetConfigCandidate({legacy, options, targetConfigPath, targetSecretsPath});
  validateTargetCandidate(candidate, {targetConfigPath, targetSecretsPath, legacy});
  const configDirectory = path.dirname(path.resolve(targetConfigPath));
  const normalized = {
    ...candidate,
    databasePath: path.resolve(configDirectory, candidate.databasePath),
    hubSecretsPath: path.resolve(configDirectory, candidate.hubSecretsPath),
    contracts: [],
  };
  const temporary = path.join(stageDir, 'target-config.json');
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {mode: 0o600});
  const runtime = await import(pathToFileURL(path.join(targetArtifact.directory, 'analytics/runtime/config.mjs')).href);
  const loaded = runtime.loadConfig(temporary);
  if (loaded.viewerAuth?.mode === 'tailscale' && typeof runtime.validateTailnetBinding === 'function') runtime.validateTailnetBinding(loaded);
  if (loaded.contracts.length !== 0 || path.resolve(loaded.databasePath) !== path.resolve(legacy.databasePath)) throw errorWithCode('Target configuration preflight failed', 'target_config_invalid');
  return loaded;
}

function retireLegacyInputs({legacy, options, targetConfigPath, targetSecretsPath, targetAnalyticsEnvPath: requestedEnvPath, backupDir} = {}) {
  const retiredDir = path.join(backupDir, 'retired-legacy-inputs');
  fs.mkdirSync(retiredDir, {recursive: true, mode: 0o700});
  const candidates = [
    ['analytics-config', legacy.analyticsFile],
    ['collector-config', legacy.collectorFile],
    ['analytics-env', legacy.analyticsEnvPath ?? options.analyticsEnvPath ?? path.join(path.dirname(legacy.analyticsFile), 'analytics.env')],
    ['collector-env', options.collectorEnvPath ?? path.join(path.dirname(legacy.collectorFile), 'collector.env')],
    ['hubs', legacy.hubsFile],
    ['hub-secrets', legacy.secretsFile],
  ];
  const moved = [];
  for (const [key, filename] of candidates) {
    if (!filename || !fs.existsSync(filename)) continue;
    const source = path.resolve(filename);
    if (source === path.resolve(targetSecretsPath)) continue;
    if (source === path.resolve(targetConfigPath)) continue;
    if (requestedEnvPath && source === path.resolve(requestedEnvPath)) continue;
    const destination = path.join(retiredDir, key);
    if (fs.existsSync(destination)) { moved.push({key, source, destination}); continue; }
    fs.renameSync(source, destination);
    moved.push({key, source, destination});
  }
  return moved;
}

function aclText(filename) {
  if (process.platform !== 'linux') return null;
  try { return execFileSync('/usr/bin/getfacl', ['--absolute-names', '-p', filename], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}); }
  catch { return null; }
}

function entryMetadata(filename, stat = fs.lstatSync(filename)) {
  return {uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, acl: aclText(filename)};
}

function applyEntryMetadata(filename, metadata) {
  if (!metadata) return;
  try { fs.chmodSync(filename, metadata.mode); } catch {}
  if (process.platform !== 'win32' && typeof metadata.uid === 'number' && typeof metadata.gid === 'number' && process.getuid?.() === 0) {
    try { if (fs.lstatSync(filename).isSymbolicLink()) fs.lchownSync(filename, metadata.uid, metadata.gid); else fs.chownSync(filename, metadata.uid, metadata.gid); } catch {}
  }
  if (metadata.acl && process.platform === 'linux') {
    try { execFileSync('/usr/bin/setfacl', ['--set-file=-', filename], {input: metadata.acl, stdio: ['pipe', 'ignore', 'ignore']}); } catch {}
  }
}

function copyEntry(source, destination, metadataOverride = null) {
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(source);
    fs.symlinkSync(target, destination);
    const metadata = metadataOverride ?? entryMetadata(source, stat);
    applyEntryMetadata(destination, metadata);
    return {type: 'symlink', target, metadata};
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, {recursive: true, mode: stat.mode & 0o777});
    for (const name of fs.readdirSync(source).sort()) {
      if (name === '.git') continue;
      copyEntry(path.join(source, name), path.join(destination, name));
    }
    const metadata = metadataOverride ?? entryMetadata(source, stat);
    applyEntryMetadata(destination, metadata);
    return {type: 'directory', metadata};
  }
  if (!stat.isFile()) throw errorWithCode('Protected backup contains an unsupported file type', 'backup_invalid_source');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const metadata = metadataOverride ?? entryMetadata(source, stat);
  applyEntryMetadata(destination, metadata);
  return {type: 'file', size: stat.size, digest: fileSha256(source), metadata};
}

export function backupProtectedLayout({backupDir, sources, state} = {}) {
  const root = absolute(backupDir);
  const protectedDir = path.join(root, 'protected');
  const manifestFile = path.join(protectedDir, 'manifest.json');
  if (fs.existsSync(manifestFile)) return readJson(manifestFile, 'Protected backup manifest');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const temporary = path.join(root, `.protected-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(temporary, {recursive: true, mode: 0o700});
  const entries = [];
  try {
    for (const source of sources) {
      if (!source.exists) { entries.push({...source, backedUp: false}); continue; }
      const target = path.join(temporary, source.key);
      const copied = copyEntry(source.path, target);
      entries.push({...source, backedUp: true, copied, sourceMetadata: copied.metadata, backupKey: source.key});
    }
    const manifest = {schemaVersion: 1, createdAt: new Date().toISOString(), phase: state?.phase ?? 'stop', oldCommitSha: state?.oldCommitSha ?? null, entries};
    fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600});
    fs.renameSync(temporary, protectedDir);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary, {recursive: true, force: true});
    throw error;
  }
}

function outboxCopy({backupDir, directory}) {
  const target = path.join(backupDir, 'outbox-pre-drain');
  if (fs.existsSync(target)) {
    const sourceNames = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
    const targetNames = fs.readdirSync(target).sort();
    if (sourceNames.length !== targetNames.length || sourceNames.some((name, index) => name !== targetNames[index])) {
      throw errorWithCode('Legacy outbox changed after its protected copy', 'outbox_changed');
    }
    for (const name of sourceNames) {
      const source = path.join(directory, name), previous = path.join(target, name);
      const sourceStat = fs.lstatSync(source), previousStat = fs.lstatSync(previous);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !previousStat.isFile() || previousStat.isSymbolicLink() || sourceStat.size !== previousStat.size || fileSha256(source) !== fileSha256(previous)) {
        throw errorWithCode('Legacy outbox changed after its protected copy', 'outbox_changed');
      }
    }
    return target;
  }
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  if (!fs.existsSync(directory)) return target;
  for (const name of fs.readdirSync(directory).sort()) {
    const source = path.join(directory, name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw errorWithCode('Outbox changed to an unsupported file while stopping', 'outbox_unsafe');
    fs.copyFileSync(source, path.join(target, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, name), stat.mode & 0o777);
  }
  return target;
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startLegacyDrainServer({legacy, oldSource, options, environment}) {
  const serverModulePath = path.join(oldSource.root, 'analytics/runtime/server.mjs');
  const configModulePath = path.join(oldSource.root, 'analytics/runtime/config.mjs');
  const port = await (options.findFreePort ?? findFreePort)();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-legacy-drain-'));
  const configFile = path.join(tempDir, 'analytics.json');
  const config = {
    version: 1,
    listen: {host: '127.0.0.1', port},
    publicOrigin: `http://127.0.0.1:${port}`,
    databasePath: legacy.databasePath,
    timeZone: legacy.analytics.timeZone,
    detailRetentionDays: legacy.analytics.detailRetentionDays,
    ingestTokenEnv: legacy.ingestEnv,
    viewerAuth: {mode: 'loopback'},
    hubs: legacy.hubs.map(hub => ({id: hub.id, label: hub.label})),
    contracts: legacy.contracts,
    demo: false,
  };
  try {
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
    const runtime = await import(pathToFileURL(configModulePath).href);
    const server = await import(pathToFileURL(serverModulePath).href);
    const loaded = runtime.loadConfig(configFile);
    const app = await server.startServer(loaded, {
      env: environment,
      logger: options.logger ?? {info() {}, error() {}},
      collectionHubs: [],
      fetchImpl: options.fetchImpl,
    });
    return {app, origin: config.publicOrigin, tempDir, configFile};
  } catch (error) {
    fs.rmSync(tempDir, {recursive: true, force: true});
    throw error;
  }
}

async function drainLegacyOutbox({legacy, oldSource, options, environment}) {
  const temp = await startLegacyDrainServer({legacy, oldSource, options, environment});
  try {
    const reset = await import(pathToFileURL(path.join(oldSource.root, 'tools/reset-hubs.mjs')).href);
    if (typeof reset.drainOutbox !== 'function') throw errorWithCode('Pinned legacy outbox drain tool is unavailable', 'legacy_tool_invalid');
    const count = await reset.drainOutbox({directory: legacy.outboxPath, origin: temp.origin, token: legacy.token, send: options.send ?? fetch});
    const after = classifyOutbox(legacy.outboxPath);
    if (!after.safe || after.json.length) throw errorWithCode('Legacy outbox did not reach an acknowledged empty state', 'outbox_not_empty');
    return {count, origin: temp.origin};
  } finally {
    try { await temp.app.close(); } finally { fs.rmSync(temp.tempDir, {recursive: true, force: true}); }
  }
}

async function verifySQLiteBackup(filename) {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    if (row?.integrity_check !== 'ok') throw errorWithCode('SQLite backup integrity check failed', 'backup_invalid');
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
  } finally { db.close(); }
  return true;
}

export async function backupPostDrainDatabase({legacy, oldSource, backupDir, state}) {
  const backupPath = path.join(absolute(backupDir), 'post-drain-analytics.db');
  const metadataPath = `${backupPath}.meta.json`;
  if (fs.existsSync(backupPath) && fs.existsSync(metadataPath)) {
    try {
      const metadata = readJson(metadataPath, 'Post-drain backup metadata', 16384);
      const stat = regularFile(backupPath, 'Post-drain database backup');
      if (metadata.schemaVersion === 1 && metadata.sourceFingerprint === state.sourceFingerprint && metadata.size === stat.size && metadata.sha256 === fileSha256(backupPath)) {
        await verifySQLiteBackup(backupPath);
        return {path: backupPath, sha256: metadata.sha256, size: metadata.size, sourceFingerprint: state.sourceFingerprint, reused: true};
      }
    } catch {}
    // A missing, stale, or partially written marker makes the database
    // untrusted. Rebuild it from the still-preserved live post-drain DB.
    fs.rmSync(backupPath, {force: true});
    fs.rmSync(metadataPath, {force: true});
  } else {
    // A crash can leave either half of the pair. Never treat that pair as a
    // completed rollback point.
    fs.rmSync(backupPath, {force: true});
    fs.rmSync(metadataPath, {force: true});
  }
  fs.mkdirSync(path.dirname(backupPath), {recursive: true, mode: 0o700});
  const sqlite = await import(pathToFileURL(path.join(oldSource.root, 'analytics/runtime/sqlite.mjs')).href);
  const temporary = `${backupPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await sqlite.backupDatabase(legacy.databasePath, temporary);
    regularFile(temporary, 'Post-drain database backup');
    await verifySQLiteBackup(temporary);
    const stat = fs.statSync(temporary);
    const result = {path: backupPath, sha256: fileSha256(temporary), size: stat.size, sourceFingerprint: state.sourceFingerprint};
    fs.renameSync(temporary, backupPath);
    writeAtomic(metadataPath, `${JSON.stringify({schemaVersion: 1, sourceFingerprint: state.sourceFingerprint, sha256: result.sha256, size: result.size})}\n`, 0o600);
    return result;
  } finally { fs.rmSync(temporary, {force: true}); }
}

async function archiveDatabase({legacy, targetArtifact, sourceCommitSha, now = new Date().toISOString()} = {}) {
  const sqlite = await import(pathToFileURL(path.join(targetArtifact.directory, 'analytics/runtime/sqlite.mjs')).href);
  const db = sqlite.openDatabase(legacy.databasePath, {demo: false});
  try {
    // Current releases expose native DatabaseSync/StatementSync objects.  A
    // short compatibility branch keeps the migration fixture usable against
    // the pre-cleanup wrapper while ensuring production archives use the
    // native statement argument API and the shared transaction helper.
    const run = (text, args) => {
      const statement = db.prepare(text);
      if (typeof statement.bind === 'function') return statement.bind(...args).run();
      return statement.run(...args);
    };
    const transaction = typeof sqlite.transaction === 'function'
      ? callback => sqlite.transaction(db, callback)
      : callback => db.transaction(callback);
    const knownHubs = new Map((legacy.hubs ?? []).map(hub => [hub.id, hub]));
    // A contract can reference an older Hub entry that was already absent
    // from one of the v1 config files. Preserve that ID in history as well;
    // its label is the only safe fallback and it receives no reconnect data.
    for (const hubId of legacy.hubIds ?? []) if (!knownHubs.has(hubId)) knownHubs.set(hubId, {id: hubId, label: hubId});
    const archiveHubs = [...knownHubs.values()].sort((a, b) => a.id.localeCompare(b.id));
    const existing = new Map(db.prepare('SELECT id,status,url,secret_ref FROM hubs').all().map(row => [row.id, row]));
    for (const hub of archiveHubs) {
      const row = existing.get(hub.id);
      if (row && !(row.status === 'archived' && row.url === null && row.secret_ref === null)) {
        throw errorWithCode(`Legacy Hub ID ${hub.id} is already registered in the target database`, 'hub_id_conflict');
      }
    }
    const archivedAt = now;
    const result = transaction(() => {
      for (const hub of archiveHubs) {
        const row = existing.get(hub.id);
        if (!row) {
          run(`INSERT INTO hubs(id,label,url,status,secret_ref,version,created_at,updated_at) VALUES(?,?,NULL,'archived',NULL,1,?,?)`, [hub.id, String(hub.label || hub.id).slice(0, 128), archivedAt, archivedAt]);
        }
        // `hubs` is the authoritative history index. The archive row has no
        // URL or Secret reference; the protected backup is the only copy of
        // those old registration values. Existing hub_snapshots and
        // contract_snapshots remain descriptive history tables, but this
        // migration does not copy legacy reconnect data into them.
      }
      for (const contract of legacy.contracts) {
        if (!contract || typeof contract !== 'object' || typeof contract.id !== 'string' || typeof contract.hubId !== 'string') continue;
        const definition = JSON.stringify(contract);
        const hash = sha256(definition);
        run(`INSERT OR IGNORE INTO contract_snapshots(contract_id,definition_hash,hub_id,label,definition_json,captured_at) VALUES(?,?,?,?,?,?)`, [contract.id, hash, contract.hubId, String(contract.label ?? contract.id), definition, archivedAt]);
      }
      return {hubs: archiveHubs.length, contracts: legacy.contracts.length};
    });
    return result;
  } finally { db.close(); }
}

function artifactIdentity(verified, targetArtifactPath) {
  return {path: path.resolve(targetArtifactPath), archiveSha256: verified.archiveSha256, releaseId: verified.manifest.releaseId, contentHash: verified.manifest.contentHash, targetCommitSha: verified.manifest.targetCommitSha};
}

async function invokePhaseHook(platform, name, context) {
  const hook = platform[name];
  if (typeof hook !== 'function') throw errorWithCode(`Migration phase ${name} requires an explicit platform handoff`, 'privilege_required');
  const result = await hook(context);
  if (result?.lockReleased === true || result?.lockHeld === false) throw errorWithCode('Privileged phase released the shared deployment lock', 'lock_handoff_invalid');
  return result;
}

function lockContext(lockPath, phase) {
  return Object.freeze({path: path.resolve(lockPath), ownerPid: process.pid, phase, held: true});
}

async function prepareContext(options) {
  ensureNoWebRunnerInvocation(options);
  const oldCommitSha = fullSha(options.oldCommitSha ?? LEGACY_COMMIT_SHA, 'Legacy commit SHA');
  if (oldCommitSha !== LEGACY_COMMIT_SHA) throw errorWithCode(`Legacy migration only accepts pinned commit ${LEGACY_COMMIT_SHA}`, 'legacy_revision_mismatch');
  const targetCommitSha = fullSha(options.targetCommitSha, 'Target commit SHA');
  if (targetCommitSha === oldCommitSha) throw errorWithCode('Target commit must differ from the pinned legacy commit', 'target_revision_mismatch');
  const statePath = absolute(options.statePath ?? path.join(process.cwd(), 'migration-state.json'));
  const state = loadMigrationState(statePath);
  if (state?.phase === 'complete') {
    if (state.oldCommitSha !== oldCommitSha || state.targetCommitSha !== targetCommitSha) throw errorWithCode('Migration state belongs to a different pinned revision', 'state_revision_mismatch');
    if (state.status === 'restored') throw errorWithCode('Migration state was restored; start a new migration state explicitly', 'migration_state_restored');
    return {options, oldCommitSha, targetCommitSha, state, completed: true, statePath};
  }
  if (!options.analyticsConfigPath || !options.collectorConfigPath) throw errorWithCode('Legacy Analytics and Collector config paths are required', 'invalid_path');
  const legacy = state?.legacyLayout && PHASE_INDEX.get(state.phase) >= PHASE_INDEX.get('finalbackup')
    ? legacyFromDescriptor(state.legacyLayout, options.environment ?? process.env, {protectedBackup: state.protectedBackup})
    : parseLegacyLayout({
      analyticsConfigPath: options.analyticsConfigPath,
      collectorConfigPath: options.collectorConfigPath,
      analyticsEnvPath: options.analyticsEnvPath,
      collectorEnvPath: options.collectorEnvPath,
      environment: options.environment ?? process.env,
    });
  const targetArtifactPath = absolute(options.targetArtifactPath);
  ensureStateInputs(state, {oldCommitSha, targetCommitSha, legacy, targetArtifactPath});
  const platform = {...defaultPlatform({...options, updateStatePath: options.updateStatePath ?? '/var/lib/tma-deploy/update-state.json'}), ...(options.platform ?? {})};
  const usesDefaultPlatform = !options.platform
    || typeof options.platform.inspectServices !== 'function'
    || typeof options.platform.provision !== 'function'
    || typeof options.platform.publish !== 'function';
  if (usesDefaultPlatform && process.platform === 'linux' && process.getuid?.() !== 0) throw errorWithCode('The migration CLI must run as root for its stop, backup, and privilege handoff phases', 'privilege_required');
  if (usesDefaultPlatform && process.platform === 'linux' && !(options.publicationUser ?? process.env.TMA_DEPLOY_USER ?? process.env.SUDO_USER)) throw errorWithCode('Set TMA_DEPLOY_USER to the ordinary publication user before migration', 'privilege_required');
  if (usesDefaultPlatform && process.platform === 'linux') {
    const productionConfig = path.join(DEFAULT_TARGET_CONFIG_DIR, 'analytics.json');
    const requestedConfig = absolute(state?.targetConfigPath ?? options.targetConfigPath ?? productionConfig);
    if (requestedConfig !== path.resolve(productionConfig)) throw errorWithCode('The Ubuntu migration target must use the provisioned Analytics config path', 'target_path_invalid');
  }
  const inspection = await inspectLayout({legacy, options, platform});
  const home = publicationHome(options);
  const inventory = inventoryLegacyLayout({legacy, options, inspection, home});
  return {options, oldCommitSha, targetCommitSha, state, statePath, legacy, targetArtifactPath, platform, inspection, inventory};
}

/** Read-only preflight. It never writes state, stops a service, or deletes outbox files. */
export async function preflightMigration(options = {}) {
  const context = await prepareContext(options);
  if (context.completed) return {alreadyComplete: true, state: context.state};
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-migration-preflight-'));
  try {
    const targetArtifact = assertSafeArtifact({targetArtifactPath: context.targetArtifactPath, targetCommitSha: context.targetCommitSha, verifier: options.verifyArtifact ?? verifyReleaseArtifact, extractDir: path.join(stageDir, 'target')});
    const sourceRoot = options.legacySourceRoot ? {root: absolute(options.legacySourceRoot)} : createPinnedSourceSnapshot({repositoryRoot: options.repositoryRoot ?? process.cwd(), targetCommitSha: context.oldCommitSha, outputDir: path.join(stageDir, 'legacy')});
    const targetConfigPath = absolute(options.targetConfigPath ?? path.join(defaultTargetConfigDir(), 'analytics.json'));
    const targetSecretsPath = absolute(options.targetSecretsPath ?? path.join(defaultTargetConfigDir(), 'hub-secrets.json'));
    const gate = await verifyTargetGate({targetArtifact, targetCommitSha: context.targetCommitSha, options, stageDir, legacy: context.legacy, targetConfigPath, targetSecretsPath});
    await validateTargetConfigurationBeforeStop({legacy: context.legacy, targetArtifact, targetConfigPath, targetSecretsPath, stageDir, options});
    return {alreadyComplete: false, oldCommitSha: context.oldCommitSha, targetCommitSha: context.targetCommitSha, legacy: context.legacy, inventory: context.inventory, targetArtifact: {...artifactIdentity(targetArtifact, context.targetArtifactPath), gate: {checks: gate?.checks ?? null}}, legacySourceRoot: sourceRoot.root};
  } finally { fs.rmSync(stageDir, {recursive: true, force: true}); }
}

async function executeMigration(context) {
  const {options, statePath, oldCommitSha, targetCommitSha, targetArtifactPath, legacy, platform} = context;
  if (context.completed) return {alreadyComplete: true, state: context.state};
  const lockPath = absolute(options.lockPath ?? '/var/lib/tma-lock/deploy.lock');
  return withPublicationLock(lockPath, async () => {
    let state = loadMigrationState(statePath);
    if (state?.phase === 'complete') return {alreadyComplete: true, state};
    const environment = legacy.environment ?? loadLegacyEnvironment({
      analyticsEnvPath: legacy.analyticsEnvPath,
      collectorEnvPath: legacy.collectorEnvPath,
      environment: options.environment ?? process.env,
      fallbackAnalyticsEnvPath: state?.protectedBackup ? path.join(state.protectedBackup, 'legacy-analytics-env') : null,
      fallbackCollectorEnvPath: state?.protectedBackup ? path.join(state.protectedBackup, 'legacy-collector-env') : null,
    });
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-migration-run-'));
    let legacySource;
    let targetArtifact;
    try {
      // All source/artifact verification and conflict checks happen before the
      // first service stop or configuration write.
      targetArtifact = assertSafeArtifact({targetArtifactPath, targetCommitSha, verifier: options.verifyArtifact ?? verifyReleaseArtifact, extractDir: path.join(stageDir, 'target')});
      legacySource = options.legacySourceRoot ? {root: absolute(options.legacySourceRoot)} : createPinnedSourceSnapshot({repositoryRoot: options.repositoryRoot ?? process.cwd(), targetCommitSha: oldCommitSha, outputDir: path.join(stageDir, 'legacy')});
      const defaultTargetConfigPath = absolute(options.targetConfigPath ?? path.join(defaultTargetConfigDir(), 'analytics.json'));
      const defaultTargetSecretsPath = absolute(options.targetSecretsPath ?? path.join(defaultTargetConfigDir(), 'hub-secrets.json'));
      const defaultTargetAnalyticsEnvPath = absolute(options.targetAnalyticsEnvPath ?? path.join(defaultTargetConfigDir(), 'analytics.env'));
      const initialTargetConfigPath = absolute(state?.targetConfigPath ?? defaultTargetConfigPath);
      const initialTargetSecretsPath = absolute(state?.targetSecretsPath ?? defaultTargetSecretsPath);
      const gate = await verifyTargetGate({targetArtifact, targetCommitSha, options, stageDir, legacy, targetConfigPath: initialTargetConfigPath, targetSecretsPath: initialTargetSecretsPath});
      await validateTargetConfigurationBeforeStop({legacy, targetArtifact, targetConfigPath: initialTargetConfigPath, targetSecretsPath: initialTargetSecretsPath, stageDir, options});
      if (!state) {
        state = saveMigrationState(statePath, {
          schemaVersion: MIGRATION_STATE_VERSION, phase: 'prepare', runId: `migration-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          oldCommitSha, targetCommitSha, sourceFingerprint: legacy.fingerprint,
          targetArtifact: {...artifactIdentity(targetArtifact, targetArtifactPath), gate: {checks: gate?.checks ?? null}},
          backupDir: absolute(options.backupDir ?? path.join(path.dirname(statePath), 'migration-backup')),
          inventory: {
            classification: context.inspection.classification,
            layout: context.inspection.layout,
            services: context.inventory.services,
            outbox: context.inventory.outbox,
            files: context.inventory.files,
          },
          legacyServices: context.inventory.services,
          targetConfigPath: initialTargetConfigPath,
          targetSecretsPath: initialTargetSecretsPath,
          targetAnalyticsEnvPath: absolute(state?.targetAnalyticsEnvPath ?? defaultTargetAnalyticsEnvPath),
          windowsInstallDir: process.platform === 'win32'
            ? absolute(options.windowsInstallDir ?? path.join(path.dirname(initialTargetConfigPath), 'application'))
            : null,
          updateStatePath: absolute(options.updateStatePath ?? '/var/lib/tma-deploy/update-state.json'),
          databasePath: path.resolve(legacy.databasePath),
          legacyDatabasePath: path.resolve(legacy.databasePath),
          legacyLayout: legacyDescriptor(legacy),
          createdAt: new Date().toISOString(), error: null,
        });
      }
      ensureStateInputs(state, {oldCommitSha, targetCommitSha, legacy, targetArtifactPath});
      const backupDir = absolute(state.backupDir);
      fs.mkdirSync(backupDir, {recursive: true, mode: 0o700});
      const phaseContext = {state, statePath, legacy, inventory: context.inventory, targetArtifact, targetArtifactPath, targetCommitSha, oldCommitSha, backupDir, lock: lockContext(lockPath, state.phase)};
      let publishedThisRun = false;

      // A persisted phase is not proof that the host is still quiescent. A
      // reboot, an administrator restart, or a transient systemd activation
      // can happen while this CLI is down. Re-inventory and re-check the
      // legacy services/database on every resume before draining, backing up,
      // or archiving. If a previous Windows publish left a child alive while
      // its state write failed, stop that child before retrying the cutover.
      if (PHASE_INDEX.get(state.phase) >= PHASE_INDEX.get('stop') && PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('publish')) {
        if (state.windowsProcess?.pid) await platform.stopNew({state, lock: lockContext(lockPath, 'resume')});
        const resumedServices = await platform.inspectServices();
        phaseContext.inventory.services = resumedServices;
        if (platform.isUpdateActive && await platform.isUpdateActive()) throw errorWithCode('An update job became active while migration was paused', 'update_conflict');
        const resumedOutbox = classifyOutbox(legacy.outboxPath);
        if (!resumedOutbox.safe) throw errorWithCode('Legacy outbox became uncertain while migration was paused', 'outbox_unsafe', {outbox: resumedOutbox});
        await platform.verifyStopped(phaseContext.inventory);
        await platform.verifyNoDatabaseWriter({databasePath: legacy.databasePath, inventory: phaseContext.inventory});
        if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('provision')) await platform.inhibitAutostart(phaseContext.inventory);
      } else if (state.phase === 'publish') {
        await platform.verifyPublished({state, lock: lockContext(lockPath, 'resume')});
      }

      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('stop')) {
        const current = await platform.inspectServices();
        phaseContext.inventory.services = current;
        state = saveMigrationState(statePath, {...state, legacyServices: current, stopAttemptedAt: new Date().toISOString(), error: null});
        phaseContext.state = state;
        await platform.stopCollector(phaseContext.inventory);
        await platform.stopAnalytics(phaseContext.inventory);
        await platform.inhibitAutostart(phaseContext.inventory);
        await platform.verifyStopped(phaseContext.inventory);
        await platform.verifyNoDatabaseWriter({databasePath: legacy.databasePath, inventory: phaseContext.inventory});
        const protectedManifest = backupProtectedLayout({backupDir, sources: context.inventory.files, state});
        outboxCopy({backupDir, directory: legacy.outboxPath});
        state = saveMigrationState(statePath, nextState(state, 'stop', {protectedBackup: path.join(backupDir, 'protected'), protectedManifest, legacyServices: phaseContext.inventory.services, stoppedAt: new Date().toISOString(), error: null}));
        phaseContext.state = state;
      }

      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('drain')) {
        const drained = await drainLegacyOutbox({legacy, oldSource: legacySource, options, environment});
        state = saveMigrationState(statePath, nextState(state, 'drain', {drained, outboxAfter: classifyOutbox(legacy.outboxPath), error: null}));
        phaseContext.state = state;
      }

      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('finalbackup')) {
        const finalDatabase = await backupPostDrainDatabase({legacy, oldSource: legacySource, backupDir, state});
        state = saveMigrationState(statePath, nextState(state, 'finalbackup', {finalDatabase, rollbackDatabase: finalDatabase.path, error: null}));
        phaseContext.state = state;
      }

      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('archive')) {
        const archived = await archiveDatabase({legacy, targetArtifact, sourceCommitSha: oldCommitSha});
        const targetFiles = writeTargetFiles({legacy, options, targetConfigPath: state.targetConfigPath, targetSecretsPath: state.targetSecretsPath, targetAnalyticsEnvPath: state.targetAnalyticsEnvPath});
        const retiredLegacyInputs = retireLegacyInputs({legacy, options, targetConfigPath: state.targetConfigPath, targetSecretsPath: state.targetSecretsPath, targetAnalyticsEnvPath: state.targetAnalyticsEnvPath, backupDir});
        state = saveMigrationState(statePath, nextState(state, 'archive', {archived, targetFiles: {configPath: targetFiles.configPath, secretsPath: targetFiles.secretsPath, analyticsEnvPath: targetFiles.analyticsEnvPath}, retiredLegacyInputs, error: null}));
        phaseContext.state = state;
      }

      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('provision')) {
        const provisioned = await invokePhaseHook(platform, 'provision', {...phaseContext, state, lock: lockContext(lockPath, 'provision')});
        state = saveMigrationState(statePath, nextState(state, 'provision', {provisioned: safeStateValue(provisioned ?? true), error: null}));
        phaseContext.state = state;
      }
      if (PHASE_INDEX.get(state.phase) < PHASE_INDEX.get('publish')) {
        await invokePhaseHook(platform, 'configure', {...phaseContext, state, lock: lockContext(lockPath, 'publish')});
        const published = await invokePhaseHook(platform, 'publish', {...phaseContext, state, lock: lockContext(lockPath, 'publish')});
        publishedThisRun = true;
        if (published?.targetCommitSha && String(published.targetCommitSha).toLowerCase() !== targetCommitSha) throw errorWithCode('Published artifact proof does not match target SHA', 'publish_proof_invalid');
        state = saveMigrationState(statePath, nextState(state, 'publish', {
          published: safeStateValue(published ?? true),
          ...(published?.windowsProcess ? {windowsProcess: safeStateValue(published.windowsProcess)} : {}),
          error: null,
        }));
        phaseContext.state = state;
      }
      if (state.phase === 'publish' && !publishedThisRun) await platform.verifyPublished({state, lock: lockContext(lockPath, 'resume')});
      state = saveMigrationState(statePath, nextState(state, 'complete', {completedAt: new Date().toISOString(), error: null}));
      return {alreadyComplete: false, state};
    } catch (error) {
      const failure = safeFailure(error);
      const current = loadMigrationState(statePath);
      if (current && current.phase !== 'complete') {
        try { saveMigrationState(statePath, {...current, error: {phase: current.phase, ...failure}, updatedAt: new Date().toISOString()}); } catch {}
      }
      throw error;
    } finally {
      fs.rmSync(stageDir, {recursive: true, force: true});
    }
  });
}

/** Execute all monotonic phases while keeping the shared lock held. */
export async function runMigration(options = {}) {
  const context = await prepareContext(options);
  return executeMigration(context);
}

function copyFileAtomic(source, destination) {
  regularFile(source, 'Restore source');
  const temporary = `${destination}.restore-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, fs.statSync(source).mode & 0o777);
  fs.renameSync(temporary, destination);
}

/**
 * Explicit rollback. It stops the new app, preserves post-cutover data, then
 * restores only the post-drain DB and the matching protected legacy layout.
 * It never points the old app at the new live database.
 */
export async function restoreMigration({statePath, lockPath, platform: suppliedPlatform, platformOptions = {}, preservePostCutover = true} = {}) {
  const stateFile = absolute(statePath);
  const state = loadMigrationState(stateFile);
  const statePhase = state && PHASE_INDEX.get(state.phase);
  // The state write immediately before the stop handoff is deliberately
  // durable.  If the process dies after that write but before the protected
  // manifest is created, recovery still has a safe path: stop whatever was
  // started, leave the current old-schema database in place, and restore the
  // recorded legacy services.  It must not pretend that a post-drain backup
  // exists or replace the database with an older copy.
  const earlyRecovery = state?.phase === 'prepare'
    && typeof state.stopAttemptedAt === 'string'
    && Array.isArray(state.legacyServices);
  const preFinalRecovery = state?.phase === 'stop' || state?.phase === 'drain';
  if (!state || (!earlyRecovery && statePhase < PHASE_INDEX.get('stop'))) throw errorWithCode('Migration has not reached a recoverable stopped phase', 'restore_unavailable');
  if (!earlyRecovery && !preFinalRecovery && statePhase < PHASE_INDEX.get('finalbackup')) throw errorWithCode('No completed post-drain backup is available for restore', 'restore_unavailable');
  if (state.status === 'restored') throw errorWithCode('This migration has already been restored', 'restore_already_applied');
  if ((!suppliedPlatform || typeof suppliedPlatform.restoreProtected !== 'function') && process.platform === 'linux' && process.getuid?.() !== 0) throw errorWithCode('Restore requires root to recover services and protected legacy files', 'privilege_required');
  const options = {...platformOptions, updateStatePath: platformOptions.updateStatePath ?? state.updateStatePath};
  const platform = {...defaultPlatform(options), ...(suppliedPlatform ?? {})};
  const lock = absolute(lockPath ?? '/var/lib/tma-lock/deploy.lock');
  return withPublicationLock(lock, async () => {
    const databasePath = state.databasePath ?? state.legacyDatabasePath;
    if (!databasePath || (!earlyRecovery && !preFinalRecovery && (!state.rollbackDatabase || !fs.existsSync(state.rollbackDatabase)))) throw errorWithCode('Migration state has no post-drain rollback database', 'restore_unavailable');
    if (!earlyRecovery && !preFinalRecovery) {
      const expected = state.finalDatabase;
      if (!expected || path.resolve(expected.path ?? '') !== path.resolve(state.rollbackDatabase)
        || !Number.isSafeInteger(expected.size) || typeof expected.sha256 !== 'string'
        || expected.sourceFingerprint !== state.sourceFingerprint) {
        throw errorWithCode('Migration rollback database metadata is incomplete', 'rollback_backup_invalid');
      }
      try {
        const stat = regularFile(state.rollbackDatabase, 'Post-drain rollback database');
        if (stat.size !== expected.size || fileSha256(state.rollbackDatabase) !== expected.sha256) throw new Error('rollback database fingerprint mismatch');
        await verifySQLiteBackup(state.rollbackDatabase);
      } catch (error) {
        throw errorWithCode('Post-drain rollback database failed integrity verification', 'rollback_backup_invalid', {cause: error});
      }
    }
    const backupDir = absolute(state.backupDir ?? path.dirname(databasePath));
    const manifest = earlyRecovery
      ? null
      : readJson(path.join(state.protectedBackup, 'manifest.json'), 'Protected backup manifest');
    const databaseEntry = (manifest?.entries ?? []).find(entry => entry.key === 'legacy-database' && entry.backedUp);
    if (!earlyRecovery && (!preFinalRecovery || state.published?.processId || state.windowsProcess?.pid)) await platform.stopNew({state, lock: lockContext(lock, 'restore')});
    if (earlyRecovery) {
      // A stop handoff may have stopped only one of the two processes before
      // failing. Use the same ordering and checks as the normal cutover, but
      // do not touch target files or the live old database.
      await platform.stopCollector({services: state.legacyServices, ...state});
      await platform.stopAnalytics({services: state.legacyServices, ...state});
      await platform.verifyStopped({services: state.legacyServices});
    }
    await platform.verifyNoDatabaseWriter({databasePath, state});
    const preservePath = preservePostCutover ? await platform.preserveCutoverDatabase({databasePath, backupDir, state, lock: lockContext(lock, 'restore')}) : null;
    if (!earlyRecovery && statePhase >= PHASE_INDEX.get('archive')) {
      const legacyFiles = new Set(Object.values(state.legacyLayout ?? {})
        .filter(value => typeof value === 'string')
        .map(value => path.resolve(value)));
      for (const filename of [state.targetConfigPath, state.targetSecretsPath, state.targetAnalyticsEnvPath]) {
        if (typeof filename === 'string' && !legacyFiles.has(path.resolve(filename))) fs.rmSync(filename, {force: true});
      }
    }
    if (!earlyRecovery && !preFinalRecovery) {
      fs.rmSync(databasePath, {force: true});
      fs.rmSync(`${databasePath}-wal`, {force: true});
      fs.rmSync(`${databasePath}-shm`, {force: true});
      if (typeof platform.restoreDatabase === 'function') await platform.restoreDatabase({source: state.rollbackDatabase, destination: databasePath, metadata: databaseEntry?.sourceMetadata ?? null, state, lock: lockContext(lock, 'restore')});
      else copyFileAtomic(state.rollbackDatabase, databasePath);
      if (databaseEntry?.sourceMetadata) applyEntryMetadata(databasePath, databaseEntry.sourceMetadata);
    }
    if (!earlyRecovery) await platform.restoreProtected({manifest, backupRoot: state.protectedBackup, state, lock: lockContext(lock, 'restore')});
    const started = await platform.startLegacy({services: state.legacyServices ?? [], state, lock: lockContext(lock, 'restore')});
    const restored = saveMigrationState(stateFile, {
      ...state,
      // Keep the monotonic phase history intact, but mark rollback explicitly
      // so a restored state cannot be mistaken for a successful cutover or
      // silently reused by the normal migration entry point.
      phase: 'complete', status: 'restored', restoredAt: new Date().toISOString(),
      restore: {status: 'restored', earlyRecovery, preFinalRecovery, postCutoverPreserved: preservePath, database: earlyRecovery || preFinalRecovery ? databasePath : state.rollbackDatabase, protectedBackup: earlyRecovery ? null : state.protectedBackup, legacyStarted: started ?? true},
      error: null,
    });
    return {state: restored, postCutoverPreserved: preservePath};
  });
}

function cliOptions(argv) {
  const {values} = parseArgs({args: argv, options: {
    'old-sha': {type: 'string', default: LEGACY_COMMIT_SHA},
    'target-sha': {type: 'string'},
    'target-artifact': {type: 'string'},
    'analytics-config': {type: 'string'},
    'collector-config': {type: 'string'},
    'analytics-env': {type: 'string'},
    'collector-env': {type: 'string'},
    'state': {type: 'string', default: path.resolve('migration-state.json')},
    'backup-dir': {type: 'string'},
    'target-config': {type: 'string'},
    'target-secrets': {type: 'string'},
    'target-analytics-env': {type: 'string'},
    'target-source-root': {type: 'string'},
    'target-host': {type: 'string'},
    'target-port': {type: 'string'},
    'target-origin': {type: 'string'},
    'target-viewer-mode': {type: 'string'},
    'windows-install-dir': {type: 'string'},
    'collector-pid': {type: 'string'},
    'analytics-pid': {type: 'string'},
    'legacy-command': {type: 'string'},
    'legacy-args': {type: 'string'},
    'legacy-working-dir': {type: 'string'},
    'publication-user': {type: 'string'},
    'publication-home': {type: 'string'},
    'legacy-code-root': {type: 'string'},
    'legacy-runner-dir': {type: 'string'},
    'legacy-node-path': {type: 'string'},
    'infrastructure-path': {type: 'string'},
    'publication-path': {type: 'string'},
    'update-state-path': {type: 'string'},
    'current-dir': {type: 'string'},
    'repository': {type: 'string', default: process.cwd()},
    'lock': {type: 'string'},
    'dry-run': {type: 'boolean', default: false},
    'web-runner': {type: 'boolean', default: false},
    restore: {type: 'boolean', default: false},
  }, allowPositionals: false, strict: true});
  return values;
}

function numericCliOption(values, name, {minimum = 1, maximum = Number.MAX_SAFE_INTEGER} = {}) {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw errorWithCode(`--${name} must be an integer in range`, 'invalid_arguments');
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const values = cliOptions(argv);
  const collectorPid = numericCliOption(values, 'collector-pid');
  const analyticsPid = numericCliOption(values, 'analytics-pid');
  const targetPort = numericCliOption(values, 'target-port', {minimum: 1, maximum: 65535});
  if (values.restore) {
    const result = await restoreMigration({statePath: values.state, lockPath: values.lock, platformOptions: {
      collectorPid, analyticsPid,
      legacyCommand: values['legacy-command'], legacyArgs: values['legacy-args'], legacyWorkingDir: values['legacy-working-dir'],
      publicationUser: values['publication-user'], publicationHome: values['publication-home'],
      currentDir: values['current-dir'], legacyCodeRoot: values['legacy-code-root'],
      legacyRunnerDir: values['legacy-runner-dir'], legacyNodePath: values['legacy-node-path'],
      infrastructurePath: values['infrastructure-path'], publicationPath: values['publication-path'],
      updateStatePath: values['update-state-path'], windowsInstallDir: values['windows-install-dir'],
    }});
    console.log(JSON.stringify({restored: true, postCutoverPreserved: result.postCutoverPreserved}, null, 2));
    return;
  }
  if (!values['target-sha'] || !values['target-artifact'] || !values['analytics-config'] || !values['collector-config']) throw errorWithCode('Specify --target-sha, --target-artifact, --analytics-config and --collector-config', 'invalid_arguments');
  const options = {
    oldCommitSha: values['old-sha'], targetCommitSha: values['target-sha'], targetArtifactPath: values['target-artifact'],
    analyticsConfigPath: values['analytics-config'], collectorConfigPath: values['collector-config'],
    analyticsEnvPath: values['analytics-env'], collectorEnvPath: values['collector-env'],
    statePath: values.state, backupDir: values['backup-dir'], targetConfigPath: values['target-config'], targetSecretsPath: values['target-secrets'], targetAnalyticsEnvPath: values['target-analytics-env'],
    targetSourceRoot: values['target-source-root'], targetHost: values['target-host'], targetPort, targetOrigin: values['target-origin'], targetViewerMode: values['target-viewer-mode'],
    windowsInstallDir: values['windows-install-dir'],
    collectorPid, analyticsPid,
    legacyCommand: values['legacy-command'], legacyArgs: values['legacy-args'], legacyWorkingDir: values['legacy-working-dir'],
    publicationUser: values['publication-user'], publicationHome: values['publication-home'],
    legacyCodeRoot: values['legacy-code-root'], legacyRunnerDir: values['legacy-runner-dir'], legacyNodePath: values['legacy-node-path'],
    infrastructurePath: values['infrastructure-path'], publicationPath: values['publication-path'], updateStatePath: values['update-state-path'], currentDir: values['current-dir'],
    repositoryRoot: values.repository, lockPath: values.lock, webRunner: values['web-runner'],
  };
  if (values['dry-run']) {
    const result = await preflightMigration(options);
    console.log(JSON.stringify({ok: true, ...result, legacy: undefined}, null, 2));
    return;
  }
  const result = await runMigration(options);
  console.log(JSON.stringify({ok: true, alreadyComplete: result.alreadyComplete, phase: result.state.phase, state: values.state}, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => { console.error(error?.message ?? 'Migration failed'); process.exitCode = 1; });
