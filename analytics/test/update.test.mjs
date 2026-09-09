import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {readUpdateState, saveUpdateState} from '../runtime/update-state.mjs';
import {UpdateManager} from '../runtime/update-manager.mjs';
import {createManagementHandler} from '../runtime/management.mjs';
import {LiveFeed} from '../runtime/live.mjs';

test('readUpdateState and saveUpdateState atomically manage job state and reconcile with service status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-update-state-'));
  const statePath = path.join(dir, 'update-state.json');

  try {
    // Missing file returns null
    assert.equal(readUpdateState(statePath), null);

    // Save initial state
    const job1 = {
      jobId: 'job-1',
      targetCommitSha: '0123456789abcdef0123456789abcdef01234567',
      targetCommitDate: '2026-09-06T12:00:00Z',
      targetMessage: 'Test commit',
      status: 'running',
      stage: 'accepted',
      errorCode: null,
      startedAt: '2026-09-06T12:00:01Z',
      finishedAt: null
    };
    saveUpdateState(statePath, job1);

    // Read while service is reported active
    const readActive = readUpdateState(statePath, {checkServiceActive: () => true});
    assert.equal(readActive.jobId, 'job-1');
    assert.equal(readActive.status, 'running');
    assert.equal(readActive.stage, 'accepted');

    // Read while service is reported INACTIVE -> should reconcile to aborted
    const readInactive = readUpdateState(statePath, {
      checkServiceActive: () => false,
      now: () => '2026-09-06T12:05:00Z'
    });
    assert.equal(readInactive.status, 'aborted');
    assert.equal(readInactive.stage, 'aborted');
    assert.equal(readInactive.errorCode, 'job_aborted');
    assert.equal(readInactive.finishedAt, '2026-09-06T12:05:00Z');

    // Subsequent read sees updated aborted state without needing service check
    const reread = readUpdateState(statePath);
    assert.equal(reread.status, 'aborted');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('UpdateManager checks candidates, enforces SHA matching, and triggers service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-update-mgr-'));
  const statePath = path.join(dir, 'update-state.json');
  const pubPath = path.join(dir, 'publication.json');

  fs.writeFileSync(pubPath, JSON.stringify({
    releaseId: 'rel-123',
    commitSha: '1111111111111111111111111111111111111111',
    commitDate: '2026-09-05T10:00:00Z',
    configurationId: 'cfg-1'
  }));

  let serviceStarted = false;
  const config = {
    demo: false,
    management: {enabled: true},
    update: {
      enabled: true,
      repositoryUrl: 'https://github.com/nuitsjp/token-monitor-analytics.git',
      branch: 'main',
      checkIntervalSeconds: 300,
      statePath,
      publicationPath: pubPath
    }
  };

  const remoteCommit = {
    commitSha: '2222222222222222222222222222222222222222',
    commitDate: '2026-09-06T12:00:00Z',
    message: 'Add system update'
  };

  const mgr = new UpdateManager(config, null, {
    fetchRemoteCommit: async () => remoteCommit,
    readState: p => readUpdateState(p, {checkServiceActive: () => false}),
    saveState: saveUpdateState,
    startService: () => { serviceStarted = true; },
    isServiceActive: () => false
  });

  // Mock platform support for testing
  mgr.isSupported = () => true;
  mgr.getSupportReason = () => null;

  try {
    const candidate = await mgr.checkUpdate();
    assert.equal(candidate.targetCommitSha, '2222222222222222222222222222222222222222');
    assert.equal(candidate.hasUpdate, true);
    assert.ok(candidate.compareUrl.includes('111111111111...222222222222'));

    const status = mgr.getStatus();
    assert.equal(status.current.commitSha, '1111111111111111111111111111111111111111');
    assert.equal(status.candidate.targetCommitSha, '2222222222222222222222222222222222222222');
    assert.equal(status.job, null);

    // Mismatched targetCommitSha is rejected
    await assert.rejects(
      mgr.applyUpdate({targetCommitSha: '3333333333333333333333333333333333333333'}),
      err => err.status === 409 && err.code === 'candidate_mismatch'
    );

    // Correct targetCommitSha triggers service
    const applied = await mgr.applyUpdate({targetCommitSha: '2222222222222222222222222222222222222222'});
    assert.equal(applied.ok, true);
    assert.equal(applied.targetCommitSha, '2222222222222222222222222222222222222222');
    assert.equal(serviceStarted, true);

    // Calling again while running is rejected with conflict
    // Mock isServiceActive as true so the job remains running
    const activeMgr = new UpdateManager(config, null, {
      fetchRemoteCommit: async () => remoteCommit,
      readState: p => readUpdateState(p, {checkServiceActive: () => true}),
      saveState: saveUpdateState,
      startService: () => {},
      isServiceActive: () => true
    });
    activeMgr.isSupported = () => true;
    activeMgr.getSupportReason = () => null;
    await activeMgr.checkUpdate();

    await assert.rejects(
      activeMgr.applyUpdate({targetCommitSha: '2222222222222222222222222222222222222222'}),
      err => err.status === 409 && err.code === 'job_already_running'
    );
  } finally {
    mgr.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('HTTP Management API protects /api/manage/update endpoints and handles check and apply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-update-http-'));
  const statePath = path.join(dir, 'update-state.json');
  const pubPath = path.join(dir, 'publication.json');

  fs.writeFileSync(pubPath, JSON.stringify({
    releaseId: 'rel-curr',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commitDate: '2026-09-01T00:00:00Z',
    configurationId: 'cfg-test'
  }));

  const config = {
    publicOrigin: 'http://127.0.0.1:8788',
    listen: {host: '127.0.0.1', port: 8788},
    demo: false,
    viewerAuth: {mode: 'loopback'},
    management: {enabled: true},
    update: {
      enabled: true,
      repositoryUrl: 'https://github.com/nuitsjp/token-monitor-analytics.git',
      branch: 'main',
      checkIntervalSeconds: 300,
      statePath,
      publicationPath: pubPath
    }
  };

  const auth = {ingest: 'token-test'};
  const live = new LiveFeed({heartbeatMs: 60000});

  let serviceStarted = false;
  const updateManager = new UpdateManager(config, live, {
    fetchRemoteCommit: async () => ({
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      commitDate: '2026-09-06T10:00:00Z',
      message: 'New release'
    }),
    readState: p => readUpdateState(p, {checkServiceActive: () => false}),
    saveState: saveUpdateState,
    startService: () => { serviceStarted = true; },
    isServiceActive: () => false
  });
  updateManager.isSupported = () => true;
  updateManager.getSupportReason = () => null;

  const management = createManagementHandler({
    config,
    auth,
    db: null,
    live,
    tracker: {getSnapshot: () => ({status: 'active'})},
    getIngestHubIds: () => [],
    setIngestHubIds: () => {},
    exclusive: fn => fn(),
    updateManager
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, config.publicOrigin);
    if (url.pathname.startsWith('/api/manage/update')) {
      await management.handleManage(req, res, url);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  config.listen.port = port;
  config.publicOrigin = `http://127.0.0.1:${port}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET status initially
    const getRes = await fetch(`${baseUrl}/api/manage/update`, {
      headers: {Host: `127.0.0.1:${port}`, Origin: config.publicOrigin}
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.current.commitSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(getBody.candidate, null);

    // 2. Cross-origin request rejected (CSRF protection)
    const badOrigin = await fetch(`${baseUrl}/api/manage/update`, {
      headers: {Host: `127.0.0.1:${port}`, Origin: 'https://evil.com'}
    });
    assert.equal(badOrigin.status, 403);

    // 3. POST /check triggers update check
    const checkRes = await fetch(`${baseUrl}/api/manage/update/check`, {
      method: 'POST',
      headers: {Host: `127.0.0.1:${port}`, Origin: config.publicOrigin, 'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    assert.equal(checkRes.status, 200);
    const checkBody = await checkRes.json();
    assert.equal(checkBody.candidate.targetCommitSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(checkBody.candidate.hasUpdate, true);

    // 4. POST /apply with invalid commit SHA is rejected
    const badApply = await fetch(`${baseUrl}/api/manage/update/apply`, {
      method: 'POST',
      headers: {Host: `127.0.0.1:${port}`, Origin: config.publicOrigin, 'Content-Type': 'application/json'},
      body: JSON.stringify({targetCommitSha: 'not-a-sha'})
    });
    assert.equal(badApply.status, 400);

    // 5. POST /apply with valid candidate SHA is accepted
    const applyRes = await fetch(`${baseUrl}/api/manage/update/apply`, {
      method: 'POST',
      headers: {Host: `127.0.0.1:${port}`, Origin: config.publicOrigin, 'Content-Type': 'application/json'},
      body: JSON.stringify({targetCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'})
    });
    assert.equal(applyRes.status, 202);
    const applyBody = await applyRes.json();
    assert.equal(applyBody.ok, true);
    assert.equal(applyBody.targetCommitSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(serviceStarted, true);
  } finally {
    live.close();
    updateManager.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('readUpdateState preserves running status during grace period even if service initially reports inactive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-grace-period-'));
  const statePath = path.join(dir, 'update-state.json');

  try {
    const job = {
      jobId: 'job-grace',
      targetCommitSha: '0123456789abcdef0123456789abcdef01234567',
      status: 'running',
      stage: 'accepted',
      startedAt: '2026-09-06T12:00:00.000Z',
      finishedAt: null
    };
    saveUpdateState(statePath, job);

    // Within grace period (3 seconds after startedAt), inactive service does NOT abort
    const duringGrace = readUpdateState(statePath, {
      checkServiceActive: () => false,
      now: () => '2026-09-06T12:00:03.000Z'
    });
    assert.equal(duringGrace.status, 'running');
    assert.equal(duringGrace.stage, 'accepted');

    // After grace period (15 seconds after startedAt), inactive service reconciles to aborted
    const afterGrace = readUpdateState(statePath, {
      checkServiceActive: () => false,
      now: () => '2026-09-06T12:00:15.000Z'
    });
    assert.equal(afterGrace.status, 'aborted');
    assert.equal(afterGrace.stage, 'aborted');
    assert.equal(afterGrace.errorCode, 'job_aborted');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('UpdateManager coalesces concurrent checkUpdate calls and broadcasts state changes via pollJobState', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-coalesce-'));
  const statePath = path.join(dir, 'update-state.json');
  const pubPath = path.join(dir, 'publication.json');

  fs.writeFileSync(pubPath, JSON.stringify({
    releaseId: 'rel-1',
    commitSha: '1111111111111111111111111111111111111111'
  }));

  let fetchCount = 0;
  const config = {
    demo: false,
    management: {enabled: true},
    update: {
      enabled: true,
      repositoryUrl: 'https://github.com/nuitsjp/token-monitor-analytics.git',
      branch: 'main',
      statePath,
      publicationPath: pubPath
    }
  };

  const broadcastEvents = [];
  const mockLive = {
    broadcast: (event, payload) => {
      broadcastEvents.push({event, payload});
    }
  };

  const mgr = new UpdateManager(config, mockLive, {
    fetchRemoteCommit: async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 50));
      return {
        commitSha: '2222222222222222222222222222222222222222',
        commitDate: '2026-09-06T12:00:00Z',
        message: 'Commit msg'
      };
    },
    readState: p => readUpdateState(p, {checkServiceActive: () => true}),
    saveState: saveUpdateState,
    startService: () => {},
    isServiceActive: () => true
  });
  mgr.isSupported = () => true;
  mgr.getSupportReason = () => null;

  try {
    // 1. Concurrent checkUpdate calls coalesce into single remote fetch
    const [c1, c2, c3] = await Promise.all([
      mgr.checkUpdate(),
      mgr.checkUpdate(),
      mgr.checkUpdate()
    ]);
    assert.equal(fetchCount, 1);
    assert.equal(c1.targetCommitSha, '2222222222222222222222222222222222222222');
    assert.equal(c2.targetCommitSha, '2222222222222222222222222222222222222222');
    assert.equal(c3.targetCommitSha, '2222222222222222222222222222222222222222');

    // 2. pollJobState detects external runner state transitions and broadcasts SSE
    const jobState = {
      jobId: 'job-ext-1',
      targetCommitSha: '2222222222222222222222222222222222222222',
      status: 'running',
      stage: 'verifying',
      errorCode: null,
      startedAt: '2026-09-06T12:00:00Z',
      finishedAt: null
    };
    saveUpdateState(statePath, jobState);

    mgr.pollJobState();
    assert.equal(broadcastEvents.length, 2); // 1 candidate updated + 1 job changed
    assert.equal(broadcastEvents[1].event, 'update_job_changed');
    assert.equal(broadcastEvents[1].payload.job.stage, 'verifying');

    // Polling again without change does not emit duplicate broadcast
    mgr.pollJobState();
    assert.equal(broadcastEvents.length, 2);

    // Stage advance to deploying emits new broadcast
    jobState.stage = 'deploying';
    saveUpdateState(statePath, jobState);
    mgr.pollJobState();
    assert.equal(broadcastEvents.length, 3);
    assert.equal(broadcastEvents[2].payload.job.stage, 'deploying');
  } finally {
    mgr.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('readUpdateState does not overwrite completed status if runner finishes during service check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-reconcile-race-'));
  const statePath = path.join(dir, 'update-state.json');

  try {
    const runningJob = {
      jobId: 'job-race-1',
      targetCommitSha: '0123456789abcdef0123456789abcdef01234567',
      targetCommitDate: '2026-09-06T12:00:00Z',
      targetMessage: 'Test message',
      status: 'running',
      stage: 'deploying',
      errorCode: null,
      startedAt: '2026-09-06T12:00:00Z',
      finishedAt: null
    };
    saveUpdateState(statePath, runningJob);

    // Simulate race: checkServiceActive is called, and during that check the runner saves completed/success
    const result = readUpdateState(statePath, {
      checkServiceActive: () => {
        saveUpdateState(statePath, {
          ...runningJob,
          status: 'completed',
          stage: 'success',
          finishedAt: '2026-09-06T12:02:00Z'
        });
        return false;
      },
      now: () => '2026-09-06T12:05:00Z'
    });

    // Should preserve completed state and NOT overwrite with aborted
    assert.equal(result.status, 'completed');
    assert.equal(result.stage, 'success');
    assert.equal(result.finishedAt, '2026-09-06T12:02:00Z');

    // Verify state on disk remains completed
    const onDisk = readUpdateState(statePath, {checkServiceActive: () => false});
    assert.equal(onDisk.status, 'completed');
    assert.equal(onDisk.stage, 'success');
    assert.equal(onDisk.finishedAt, '2026-09-06T12:02:00Z');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('readUpdateState never resurrects an older job after a replacement during service check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-reconcile-replacement-'));
  const statePath = path.join(dir, 'update-state.json');
  const oldJob = {
    jobId: 'job-old',
    targetCommitSha: '0123456789abcdef0123456789abcdef01234567',
    status: 'running',
    stage: 'deploying',
    startedAt: '2026-09-06T12:00:00Z',
    finishedAt: null
  };
  const newJob = {
    ...oldJob,
    jobId: 'job-new',
    targetCommitSha: 'fedcba9876543210fedcba9876543210fedcba98',
    stage: 'accepted',
    startedAt: '2026-09-06T12:04:00Z'
  };
  try {
    saveUpdateState(statePath, oldJob);
    const result = readUpdateState(statePath, {
      checkServiceActive: () => {
        saveUpdateState(statePath, newJob);
        return false;
      },
      now: () => '2026-09-06T12:05:00Z'
    });
    assert.equal(result.jobId, 'job-new');
    assert.equal(result.status, 'running');
    assert.equal(readUpdateState(statePath, {checkServiceActive: () => true}).jobId, 'job-new');

    saveUpdateState(statePath, oldJob);
    const missing = readUpdateState(statePath, {
      checkServiceActive: () => {
        fs.rmSync(statePath);
        return false;
      },
      now: () => '2026-09-06T12:05:00Z'
    });
    assert.equal(missing, null);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('update state preserves pinned repository and verified release metadata through terminal reconciliation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-test-update-metadata-'));
  const statePath = path.join(dir, 'update-state.json');
  const state = {
    jobId: 'job-metadata',
    targetCommitSha: '0123456789abcdef0123456789abcdef01234567',
    targetCommitDate: '2026-09-09T00:00:00Z',
    targetMessage: 'Verified release',
    repositoryUrl: 'https://example.invalid/repository.git',
    branch: 'main',
    initialConfigurationId: 'cfg-before',
    expectedReleaseId: 'rel-after',
    contentHash: 'b'.repeat(64),
    archiveSha256: 'a'.repeat(64),
    configurationId: 'cfg-after',
    status: 'completed',
    stage: 'success',
    errorCode: null,
    startedAt: '2026-09-09T00:00:01Z',
    finishedAt: '2026-09-09T00:01:00Z'
  };
  try {
    saveUpdateState(statePath, state);
    const read = readUpdateState(statePath, {checkServiceActive: () => false});
    assert.equal(read.repositoryUrl, state.repositoryUrl);
    assert.equal(read.branch, state.branch);
    assert.equal(read.expectedReleaseId, state.expectedReleaseId);
    assert.equal(read.contentHash, state.contentHash);
    assert.equal(read.archiveSha256, state.archiveSha256);
    assert.equal(read.configurationId, state.configurationId);
    assert.equal(read.status, 'completed');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
