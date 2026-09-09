import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateRestartController} from '../public/update-restart.mjs';

const response = body => ({ok: true, async json() { return body; }});

test('restart controller completes a same-content no-op without claiming the requested SHA is running', async () => {
  const events = [];
  const controller = createUpdateRestartController({
    intervalMs: 1,
    fetchHealth: async () => response({ok: true}),
    fetchStatus: async () => response({
      current: {commitSha: 'old-sha'},
      job: {jobId: 'job-1', targetCommitSha: 'new-sha', status: 'completed', stage: 'success', outcome: 'unchanged'}
    }),
    onSuccess: result => events.push(result)
  });
  assert.equal(controller.start('job-1', 'new-sha'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].unchanged, true);
  assert.equal(events[0].current.commitSha, 'old-sha');
  assert.equal(controller.isActive(), false);
});

test('restart controller stops promptly on a terminal failure even when health is down', async () => {
  const failures = [];
  const controller = createUpdateRestartController({
    intervalMs: 1000,
    fetchHealth: async () => { throw new Error('application stopped'); },
    fetchStatus: async () => response({current: {}, job: {jobId: 'job-2', status: 'failed', stage: 'failed', errorCode: 'health_check_failed'}}),
    onFailure: job => failures.push(job)
  });
  controller.start('job-2', 'new-sha');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'health_check_failed');
  assert.equal(controller.isActive(), false);
});

test('restart controller never overlaps status polls', async () => {
  let inFlight = 0;
  let maximum = 0;
  let calls = 0;
  const controller = createUpdateRestartController({
    intervalMs: 1,
    fetchHealth: async () => response({ok: true}),
    fetchStatus: async () => {
      inFlight += 1; maximum = Math.max(maximum, inFlight); calls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return response({current: {commitSha: 'new-sha'}, job: {jobId: 'job-3', status: 'completed', stage: 'success'}});
    },
    onSuccess: () => {}
  });
  controller.start('job-3', 'new-sha');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(maximum, 1);
  assert.equal(calls, 1);
  assert.equal(controller.isActive(), false);
});
