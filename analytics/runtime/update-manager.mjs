import {execFile, spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {readUpdateState, saveUpdateState} from './update-state.mjs';
import {publicUpdateJob} from './update-recovery.mjs';

const execFileAsync = promisify(execFile);

function defaultReadPublication(pubPath) {
  if (!pubPath || !fs.existsSync(pubPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(pubPath, 'utf8').replace(/^\uFEFF/, ''));
    return {
      releaseId: typeof raw.releaseId === 'string' ? raw.releaseId : null,
      configurationId: typeof raw.configurationId === 'string' ? raw.configurationId : null,
      publicOrigin: typeof raw.publicOrigin === 'string' ? raw.publicOrigin : null,
      commitSha: typeof raw.commitSha === 'string' ? raw.commitSha : (typeof raw.targetCommitSha === 'string' ? raw.targetCommitSha : null),
      commitDate: typeof raw.commitDate === 'string' ? raw.commitDate : (typeof raw.targetCommitDate === 'string' ? raw.targetCommitDate : null),
      contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
      archiveSha256: typeof raw.archiveSha256 === 'string' ? raw.archiveSha256 : null,
      publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null
    };
  } catch {
    return null;
  }
}

async function defaultFetchRemoteCommit({repositoryUrl, branch}) {
  const {stdout} = await execFileAsync('git', ['ls-remote', repositoryUrl, `refs/heads/${branch}`], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const match = /^([0-9a-f]{40})\s+/m.exec(stdout);
  if (!match) throw new Error('Cannot find branch reference in remote repository');
  return {
    commitSha: match[1],
    commitDate: null,
    message: null
  };
}

function defaultStartService(unitName = 'tma-update.service') {
  if (process.platform !== 'linux') throw new Error('systemd service control is only supported on Linux');
  const child = spawn('/usr/bin/systemctl', ['--user', 'start', unitName], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function defaultIsServiceActive(unitName = 'tma-update.service') {
  if (process.platform !== 'linux') return false;
  try {
    const res = spawnSync('/usr/bin/systemctl', ['--user', 'show', '--property=ActiveState', '--value', unitName], {
      encoding: 'utf8'
    });
    if (res.status !== 0 || !res.stdout) return false;
    const activeState = res.stdout.trim();
    return activeState === 'active' || activeState === 'activating';
  } catch {
    return false;
  }
}

export class UpdateManager {
  #config;
  #closed = false;
  #live;
  #timer = null;
  #watchTimer = null;
  #fileWatcher = null;
  #candidate = null;
  #lastCheckedAt = null;
  #checkingPromise = null;
  #lastJobKey = null;
  #fetchRemoteCommit;
  #readPublication;
  #readState;
  #saveState;
  #startService;
  #isServiceActive;

  constructor(config, live, {
    fetchRemoteCommit = defaultFetchRemoteCommit,
    readPublication = defaultReadPublication,
    readState = readUpdateState,
    saveState = saveUpdateState,
    startService = defaultStartService,
    isServiceActive = defaultIsServiceActive
  } = {}) {
    this.#config = config;
    this.#live = live;
    this.#fetchRemoteCommit = fetchRemoteCommit;
    this.#readPublication = readPublication;
    this.#readState = readState;
    this.#saveState = saveState;
    this.#startService = startService;
    this.#isServiceActive = isServiceActive;
  }

  isSupported() {
    if (this.#config.demo) return false;
    if (process.platform !== 'linux') return false;
    return true;
  }

  getSupportReason() {
    if (this.#config.demo) return 'demo_mode';
    if (process.platform !== 'linux') return 'unsupported_platform';
    if (!this.#config.management?.enabled) return 'management_disabled';
    if (!this.#config.update?.enabled) return 'update_disabled';
    return null;
  }

  start() {
    if (!this.isSupported() || !this.#config.management?.enabled || !this.#config.update?.enabled) {
      return;
    }
    const intervalSec = this.#config.update.checkIntervalSeconds ?? 300;
    this.#timer = setInterval(() => {
      this.checkUpdate().catch(() => {});
    }, intervalSec * 1000);
    this.#timer.unref();

    // Initial check
    setTimeout(() => {
      this.checkUpdate().catch(() => {});
    }, 2000).unref();

    // Monitor update state file for real-time SSE updates
    const statePath = this.#config.update?.statePath ?? '/var/lib/tma-deploy/update-state.json';
    try {
      const dir = path.dirname(statePath);
      if (fs.existsSync(dir)) {
        this.#fileWatcher = fs.watch(dir, () => {
          this.pollJobState();
        });
      }
    } catch {}

    this.#watchTimer = setInterval(() => {
      this.pollJobState();
    }, 1000);
    this.#watchTimer.unref();
  }

  close() {
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#fileWatcher) {
      try { this.#fileWatcher.close(); } catch {}
      this.#fileWatcher = null;
    }
    if (this.#watchTimer) {
      clearInterval(this.#watchTimer);
      this.#watchTimer = null;
    }
  }

  pollJobState(force = false, {reconcile = true} = {}) {
    const statePath = this.#config.update?.statePath ?? '/var/lib/tma-deploy/update-state.json';
    const job = this.#readState(statePath, {checkServiceActive: reconcile && !this.#closed ? this.#isServiceActive : () => true});
    const publicJob = publicUpdateJob(job);
    const key = publicJob ? `${publicJob.jobId}:${publicJob.status}:${publicJob.stage}:${publicJob.failedStage}:${publicJob.errorCode}` : null;
    if (force || key !== this.#lastJobKey) {
      this.#lastJobKey = key;
      if (this.#live && publicJob) {
        this.#live.broadcast('update_job_changed', {
          type: 'update_job_changed',
          job: publicJob
        });
      }
    }
    return job;
  }

  async checkUpdate() {
    if (!this.isSupported() || !this.#config.update?.enabled) {
      return null;
    }
    if (this.#checkingPromise) {
      return this.#checkingPromise;
    }
    this.#checkingPromise = this.#performCheckUpdate().finally(() => {
      this.#checkingPromise = null;
    });
    return this.#checkingPromise;
  }

  async #performCheckUpdate() {
    const {repositoryUrl, branch, publicationPath} = this.#config.update;
    const pub = this.#readPublication(publicationPath);
    const currentSha = pub?.commitSha ?? null;

    try {
      const remote = await this.#fetchRemoteCommit({repositoryUrl, branch});
      const targetSha = typeof remote.commitSha === 'string' ? remote.commitSha.toLowerCase() : remote.commitSha;
      if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
        throw Object.assign(new Error('Remote branch did not return a full commit SHA'), {code: 'invalid_remote_commit'});
      }
      const hasUpdate = Boolean(currentSha ? currentSha !== targetSha : true);
      const webBase = repositoryUrl.replace(/\.git$/, '');
      const compareUrl = currentSha && currentSha !== targetSha
        ? `${webBase}/compare/${currentSha.slice(0, 12)}...${targetSha.slice(0, 12)}`
        : `${webBase}/commit/${targetSha}`;

      this.#lastCheckedAt = new Date().toISOString();
      this.#candidate = {
        targetCommitSha: targetSha,
        commitDate: remote.commitDate,
        message: remote.message,
        compareUrl,
        lastCheckedAt: this.#lastCheckedAt,
        hasUpdate
      };

      if (this.#live) {
        this.#live.broadcast('update_candidate_updated', {
          type: 'update_candidate_updated',
          candidate: this.#candidate
        });
      }
      return this.#candidate;
    } catch (err) {
      this.#lastCheckedAt = new Date().toISOString();
      if (this.#candidate) {
        this.#candidate.lastCheckedAt = this.#lastCheckedAt;
      }
      throw err;
    }
  }

  getStatus() {
    const supported = this.isSupported();
    const reason = this.getSupportReason();
    const enabled = Boolean(supported && this.#config.management?.enabled && this.#config.update?.enabled);

    const publicationPath = this.#config.update?.publicationPath ?? '/opt/token-monitor-analytics/publication.json';
    const pub = this.#readPublication(publicationPath);
    const current = {
      releaseId: pub?.releaseId ?? null,
      commitSha: pub?.commitSha ?? null,
      commitDate: pub?.commitDate ?? null,
      configurationId: pub?.configurationId ?? null,
      contentHash: pub?.contentHash ?? null,
      archiveSha256: pub?.archiveSha256 ?? null
    };

    const statePath = this.#config.update?.statePath ?? '/var/lib/tma-deploy/update-state.json';
    const job = this.#readState(statePath, {checkServiceActive: this.#isServiceActive});

    return {
      supported,
      enabled,
      reason: reason ?? undefined,
      current,
      candidate: this.#candidate,
      job: publicUpdateJob(job)
    };
  }

  async applyUpdate({targetCommitSha}) {
    if (!this.isSupported()) {
      throw Object.assign(new Error(`System update is not supported: ${this.getSupportReason()}`), {status: 400});
    }
    if (!this.#config.management?.enabled || !this.#config.update?.enabled) {
      throw Object.assign(new Error('System update is disabled'), {status: 403});
    }
    if (!targetCommitSha || typeof targetCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(targetCommitSha)) {
      throw Object.assign(new Error('Invalid commit SHA format'), {status: 400});
    }

    if (!this.#candidate || this.#candidate.targetCommitSha !== targetCommitSha) {
      throw Object.assign(new Error('Target commit SHA does not match current candidate. Please refresh update candidate.'), {status: 409, code: 'candidate_mismatch'});
    }
    if (!this.#candidate.hasUpdate) {
      throw Object.assign(new Error('The selected commit is already published'), {status: 409, code: 'already_current'});
    }

    const statePath = this.#config.update.statePath;
    const currentJob = this.#readState(statePath, {checkServiceActive: this.#isServiceActive});
    if (currentJob && currentJob.status === 'running') {
      throw Object.assign(new Error('An update job is already in progress'), {status: 409, code: 'job_already_running'});
    }

    const jobId = `update-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const newJob = {
      jobId,
      targetCommitSha,
      targetCommitDate: this.#candidate.commitDate,
      targetMessage: this.#candidate.message,
      repositoryUrl: this.#config.update.repositoryUrl,
      branch: this.#config.update.branch,
      initialConfigurationId: this.#readPublication(this.#config.update.publicationPath)?.configurationId ?? null,
      expectedReleaseId: null,
      contentHash: null,
      archiveSha256: null,
      configurationId: null,
      outcome: null,
      status: 'running',
      stage: 'accepted',
      failedStage: null,
      errorCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };

    this.#saveState(statePath, newJob);

    try {
      this.#startService('tma-update.service');
    } catch (err) {
      newJob.status = 'failed';
      newJob.stage = 'failed';
      newJob.failedStage = newJob.failedStage ?? 'accepted';
      newJob.errorCode = 'job_aborted';
      newJob.finishedAt = new Date().toISOString();
      this.#saveState(statePath, newJob);
      throw Object.assign(new Error(`Failed to trigger update service: ${err.message}`), {status: 500});
    }

    this.#lastJobKey = `${newJob.jobId}:${newJob.status}:${newJob.stage}:${newJob.failedStage}:${newJob.errorCode}`;

    if (this.#live) {
      this.#live.broadcast('update_job_changed', {
        type: 'update_job_changed',
        job: publicUpdateJob(newJob)
      });
    }

    return {
      ok: true,
      jobId,
      targetCommitSha
    };
  }
}
