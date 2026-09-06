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
    const res = spawnSync('/usr/bin/systemctl', ['--user', 'is-active', '--quiet', unitName]);
    return res.status === 0;
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
    const isActive = checkServiceActive('tma-update.service');
    if (!isActive) {
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
