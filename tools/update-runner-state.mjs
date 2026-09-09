import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// This module is copied with the fixed update runner.  Keep it independent of
// Analytics configuration, SQLite, and release application code.
export const VALID_STAGES = new Set([
  'accepted',
  'fetching',
  'verifying',
  'deploying',
  'restarting',
  'success',
  'failed',
  'aborted'
]);

export const VALID_STATUSES = new Set(['idle', 'running', 'completed', 'failed', 'aborted']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);

function defaultCheckServiceActive(unitName = 'tma-update.service') {
  if (process.platform !== 'linux') return false;
  try {
    const result = spawnSync('/usr/bin/systemctl', ['--user', 'show', '--property=ActiveState', '--value', unitName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0) return false;
    const value = result.stdout?.trim();
    return value === 'active' || value === 'activating';
  } catch {
    return false;
  }
}

function stateObject(raw, fallbackStartedAt) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.jobId !== 'string' || !raw.jobId || typeof raw.targetCommitSha !== 'string' || !raw.targetCommitSha) return null;
  const status = VALID_STATUSES.has(raw.status) ? raw.status : 'aborted';
  const stage = VALID_STAGES.has(raw.stage) ? raw.stage : 'aborted';
  return {
    jobId: raw.jobId,
    targetCommitSha: raw.targetCommitSha,
    targetCommitDate: typeof raw.targetCommitDate === 'string' ? raw.targetCommitDate : null,
    targetMessage: typeof raw.targetMessage === 'string' ? raw.targetMessage : null,
    repositoryUrl: typeof raw.repositoryUrl === 'string' ? raw.repositoryUrl : null,
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    initialConfigurationId: typeof raw.initialConfigurationId === 'string' ? raw.initialConfigurationId : null,
    expectedReleaseId: typeof raw.expectedReleaseId === 'string' ? raw.expectedReleaseId : null,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    archiveSha256: typeof raw.archiveSha256 === 'string' ? raw.archiveSha256 : null,
    configurationId: typeof raw.configurationId === 'string' ? raw.configurationId : null,
    status,
    stage,
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : fallbackStartedAt,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null
  };
}

function readRaw(statePath) {
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Read update state without loading any application module.  A runner that is
 * still alive is authoritative for a running job; the service check is only a
 * recovery path for a process that disappeared.
 */
export function readRunnerState(statePath, {
  checkServiceActive = defaultCheckServiceActive,
  now = () => new Date().toISOString(),
  graceMs = 10000
} = {}) {
  if (!statePath) return null;
  const raw = readRaw(statePath);
  const state = stateObject(raw, now());
  if (!state) return null;
  if (state.status !== 'running') return state;

  const started = Date.parse(state.startedAt);
  const current = Date.parse(now());
  const elapsed = Number.isFinite(started) && Number.isFinite(current) ? Math.abs(current - started) : graceMs;
  if (elapsed < graceMs || checkServiceActive('tma-update.service')) return state;

  // Re-read after the potentially slow service query.  This prevents a
  // completed runner from being changed to aborted by a concurrent UI poll.
  const latest = stateObject(readRaw(statePath), state.startedAt);
  // A newer job may have replaced this file while the service query was in
  // progress. Never resurrect or overwrite that newer job with stale data.
  if (!latest || latest.jobId !== state.jobId) return latest;
  if (latest.status !== 'running') return latest;

  const corrected = {
    ...state,
    status: 'aborted',
    stage: 'aborted',
    errorCode: state.errorCode || 'job_aborted',
    finishedAt: state.finishedAt || now()
  };
  try { saveRunnerState(statePath, corrected); } catch {}
  return corrected;
}

function privateStatePath(statePath) {
  const parent = path.dirname(statePath);
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  try {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Update state directory must be private');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Atomically save only non-secret update metadata with mode 0600. */
export function saveRunnerState(statePath, state) {
  if (!statePath || !state || typeof state !== 'object') throw new Error('Update state is required');
  privateStatePath(statePath);
  const payload = {
    jobId: state.jobId,
    targetCommitSha: state.targetCommitSha,
    targetCommitDate: state.targetCommitDate ?? null,
    targetMessage: state.targetMessage ?? null,
    repositoryUrl: state.repositoryUrl ?? null,
    branch: state.branch ?? null,
    initialConfigurationId: state.initialConfigurationId ?? null,
    expectedReleaseId: state.expectedReleaseId ?? null,
    contentHash: state.contentHash ?? null,
    archiveSha256: state.archiveSha256 ?? null,
    configurationId: state.configurationId ?? null,
    status: state.status,
    stage: state.stage,
    errorCode: state.errorCode ?? null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null
  };
  const temporary = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, statePath);
    fs.chmodSync(statePath, 0o600);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
}

export function isTerminalState(state) {
  return Boolean(state && TERMINAL_STATUSES.has(state.status));
}
