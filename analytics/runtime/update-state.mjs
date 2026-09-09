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
  const metadata = {
    repositoryUrl: typeof raw.repositoryUrl === 'string' ? raw.repositoryUrl : null,
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    initialConfigurationId: typeof raw.initialConfigurationId === 'string' ? raw.initialConfigurationId : null,
    expectedReleaseId: typeof raw.expectedReleaseId === 'string' ? raw.expectedReleaseId : null,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    archiveSha256: typeof raw.archiveSha256 === 'string' ? raw.archiveSha256 : null,
    configurationId: typeof raw.configurationId === 'string' ? raw.configurationId : null,
    outcome: raw.outcome === 'updated' || raw.outcome === 'unchanged' ? raw.outcome : null
  };

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

      const latestJobId = latestRaw && typeof latestRaw === 'object' && typeof latestRaw.jobId === 'string' ? latestRaw.jobId : null;
      if (!latestJobId || latestJobId !== jobId) {
        // A replacement job (or a removed state file) wins over this stale
        // read. Returning null for a missing/invalid file avoids resurrecting
        // the old job in a UI poll.
        if (!latestJobId) return null;
        const latestStatus = VALID_STATUSES.has(latestRaw.status) ? latestRaw.status : 'aborted';
        const latestStage = VALID_STAGES.has(latestRaw.stage) ? latestRaw.stage : 'aborted';
        return {
          jobId: latestJobId,
          targetCommitSha: typeof latestRaw.targetCommitSha === 'string' ? latestRaw.targetCommitSha : null,
          targetCommitDate: latestRaw.targetCommitDate || null,
          targetMessage: latestRaw.targetMessage || null,
          repositoryUrl: latestRaw.repositoryUrl || null,
          branch: latestRaw.branch || null,
          initialConfigurationId: latestRaw.initialConfigurationId || null,
          expectedReleaseId: latestRaw.expectedReleaseId || null,
          contentHash: latestRaw.contentHash || null,
          archiveSha256: latestRaw.archiveSha256 || null,
          configurationId: latestRaw.configurationId || null,
          outcome: latestRaw.outcome === 'updated' || latestRaw.outcome === 'unchanged' ? latestRaw.outcome : null,
          status: latestStatus,
          stage: latestStage,
          errorCode: typeof latestRaw.errorCode === 'string' ? latestRaw.errorCode : null,
          startedAt: typeof latestRaw.startedAt === 'string' ? latestRaw.startedAt : now(),
          finishedAt: typeof latestRaw.finishedAt === 'string' ? latestRaw.finishedAt : null
        };
      }
      if (latestRaw.status !== 'running') {
        // Runner already saved terminal status (completed/failed/aborted); do not overwrite!
        return {
          jobId,
          targetCommitSha: typeof latestRaw.targetCommitSha === 'string' ? latestRaw.targetCommitSha : targetCommitSha,
          targetCommitDate: latestRaw.targetCommitDate || null,
          targetMessage: latestRaw.targetMessage || null,
          repositoryUrl: latestRaw.repositoryUrl || null,
          branch: latestRaw.branch || null,
          initialConfigurationId: latestRaw.initialConfigurationId || null,
          expectedReleaseId: latestRaw.expectedReleaseId || null,
          contentHash: latestRaw.contentHash || null,
          archiveSha256: latestRaw.archiveSha256 || null,
          configurationId: latestRaw.configurationId || null,
          outcome: latestRaw.outcome === 'updated' || latestRaw.outcome === 'unchanged' ? latestRaw.outcome : null,
          status: VALID_STATUSES.has(latestRaw.status) ? latestRaw.status : 'aborted',
          stage: VALID_STAGES.has(latestRaw.stage) ? latestRaw.stage : 'aborted',
          errorCode: typeof latestRaw.errorCode === 'string' ? latestRaw.errorCode : null,
          startedAt: typeof latestRaw.startedAt === 'string' ? latestRaw.startedAt : startedAt,
          finishedAt: typeof latestRaw.finishedAt === 'string' ? latestRaw.finishedAt : null
        };
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
        ...metadata,
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
    ...metadata,
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
    repositoryUrl: state.repositoryUrl ?? null,
    branch: state.branch ?? null,
    initialConfigurationId: state.initialConfigurationId ?? null,
    expectedReleaseId: state.expectedReleaseId ?? null,
    contentHash: state.contentHash ?? null,
    archiveSha256: state.archiveSha256 ?? null,
    configurationId: state.configurationId ?? null,
    outcome: state.outcome ?? null,
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
