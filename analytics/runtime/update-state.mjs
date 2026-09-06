import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

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

export const VALID_STATUSES = new Set([
  'idle',
  'running',
  'completed',
  'failed',
  'aborted'
]);

function defaultCheckServiceActive(unitName = 'tma-update.service') {
  if (process.platform !== 'linux') return false;
  try {
    const res = spawnSync('/usr/bin/systemctl', ['--user', 'show', '--property=ActiveState', '--value', unitName], {encoding: 'utf8'});
    if (res.status !== 0 || !res.stdout) return false;
    const activeState = res.stdout.trim();
    return activeState === 'active' || activeState === 'activating';
  } catch {
    return false;
  }
}

export function readUpdateState(statePath, {checkServiceActive = defaultCheckServiceActive, now = () => new Date().toISOString()} = {}) {
  if (!statePath || !fs.existsSync(statePath)) {
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;

  const jobId = typeof raw.jobId === 'string' ? raw.jobId : null;
  const targetCommitSha = typeof raw.targetCommitSha === 'string' ? raw.targetCommitSha : null;
  if (!jobId || !targetCommitSha) return null;

  let status = VALID_STATUSES.has(raw.status) ? raw.status : 'aborted';
  let stage = VALID_STAGES.has(raw.stage) ? raw.stage : 'aborted';
  let errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : null;
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : now();
  let finishedAt = typeof raw.finishedAt === 'string' ? raw.finishedAt : null;

  // Reconcile running status against systemd
  if (status === 'running') {
    const elapsedMs = Math.abs(Date.parse(now()) - Date.parse(startedAt));
    const isGracePeriod = Number.isFinite(elapsedMs) && elapsedMs < 10000;
    const isActive = checkServiceActive('tma-update.service');
    if (!isActive && !isGracePeriod) {
      // Re-read latest state file from disk to avoid overwriting a completion saved by the runner while checkServiceActive was executing.
      let latestRaw = null;
      try {
        latestRaw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
      } catch {}

      if (latestRaw && typeof latestRaw === 'object' && latestRaw.jobId === jobId) {
        if (latestRaw.status !== 'running') {
          // Runner already saved terminal status (completed/failed/aborted); do not overwrite!
          return {
            jobId,
            targetCommitSha: typeof latestRaw.targetCommitSha === 'string' ? latestRaw.targetCommitSha : targetCommitSha,
            targetCommitDate: latestRaw.targetCommitDate || null,
            targetMessage: latestRaw.targetMessage || null,
            status: VALID_STATUSES.has(latestRaw.status) ? latestRaw.status : 'aborted',
            stage: VALID_STAGES.has(latestRaw.stage) ? latestRaw.stage : 'aborted',
            errorCode: typeof latestRaw.errorCode === 'string' ? latestRaw.errorCode : null,
            startedAt: typeof latestRaw.startedAt === 'string' ? latestRaw.startedAt : startedAt,
            finishedAt: typeof latestRaw.finishedAt === 'string' ? latestRaw.finishedAt : null
          };
        }
      }

      status = 'aborted';
      stage = 'aborted';
      errorCode = errorCode || 'job_aborted';
      finishedAt = finishedAt || now();

      const corrected = {
        jobId,
        targetCommitSha,
        targetCommitDate: raw.targetCommitDate || null,
        targetMessage: raw.targetMessage || null,
        status,
        stage,
        errorCode,
        startedAt,
        finishedAt
      };
      try {
        saveUpdateState(statePath, corrected);
      } catch {}
      return corrected;
    }
  }

  return {
    jobId,
    targetCommitSha,
    targetCommitDate: raw.targetCommitDate || null,
    targetMessage: raw.targetMessage || null,
    status,
    stage,
    errorCode,
    startedAt,
    finishedAt
  };
}

export function saveUpdateState(statePath, state) {
  if (!statePath) throw new Error('statePath is required');
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  }

  const payload = {
    jobId: state.jobId,
    targetCommitSha: state.targetCommitSha,
    targetCommitDate: state.targetCommitDate ?? null,
    targetMessage: state.targetMessage ?? null,
    status: state.status,
    stage: state.stage,
    errorCode: state.errorCode ?? null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null
  };

  const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  const content = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(temp, content, {mode: 0o600, flag: 'wx'});
  fs.renameSync(temp, statePath);
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {}
}
