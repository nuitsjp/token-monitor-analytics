import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {destination, prefix, repoDir, updateStateFile, infrastructureFile, validateInfrastructure, assertInfrastructureFile} from './ubuntu-layout.mjs';
import {readJSON, selectConfiguration, validateConfiguration} from './publish-config.mjs';
import {userEnvironment, inherit, report} from './ubuntu-common.mjs';
import {readUpdateState, saveUpdateState} from '../analytics/runtime/update-state.mjs';

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {encoding: 'utf8', stdio: 'pipe', ...options});
  } catch {
    throw new Error(`${path.basename(command)} failed; sensitive output suppressed.`);
  }
}

async function runUpdate() {
  userEnvironment();
  if (process.getuid() === 0) throw new Error('Update runner must run as the ordinary publication user, not root.');

  if (!fs.existsSync(infrastructureFile)) throw new Error('Infrastructure record is missing.');
  assertInfrastructureFile();
  validateInfrastructure(readJSON(infrastructureFile), process.getuid());

  const state = readUpdateState(updateStateFile, {checkServiceActive: () => true});
  if (!state || state.status !== 'running') {
    return;
  }

  const {jobId, targetCommitSha} = state;
  const setStage = (stage, {status = 'running', errorCode = null, targetCommitDate = state.targetCommitDate, targetMessage = state.targetMessage} = {}) => {
    const finishedAt = ['completed', 'failed', 'aborted'].includes(status) ? new Date().toISOString() : null;
    const nextState = {
      jobId,
      targetCommitSha,
      targetCommitDate,
      targetMessage,
      status,
      stage,
      errorCode,
      startedAt: state.startedAt,
      finishedAt
    };
    saveUpdateState(updateStateFile, nextState);
  };

  const plan = readJSON(`${destination}/connection.json`);
  const selected = selectConfiguration(plan);
  const config = validateConfiguration(plan, selected);
  const repositoryUrl = config.analytics.update?.repositoryUrl ?? 'https://github.com/nuitsjp/token-monitor-analytics.git';
  const branch = config.analytics.update?.branch ?? 'main';

  // 1. Stage: Fetching
  setStage('fetching');
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, {recursive: true, mode: 0o700});
  }
  const isGitRepo = fs.existsSync(path.join(repoDir, 'HEAD')) || fs.existsSync(path.join(repoDir, '.git'));
  if (!isGitRepo) {
    run('/usr/bin/git', ['init', '--bare', repoDir]);
    run('/usr/bin/git', ['remote', 'add', 'origin', repositoryUrl], {cwd: repoDir});
  } else {
    try {
      run('/usr/bin/git', ['remote', 'set-url', 'origin', repositoryUrl], {cwd: repoDir});
    } catch {
      run('/usr/bin/git', ['remote', 'add', 'origin', repositoryUrl], {cwd: repoDir});
    }
  }

  try {
    run('/usr/bin/git', ['fetch', 'origin', branch, '--tags'], {cwd: repoDir});
  } catch (err) {
    setStage('failed', {status: 'failed', errorCode: 'fetch_failed'});
    return;
  }

  let commitDate = state.targetCommitDate;
  let commitMessage = state.targetMessage;
  try {
    run('/usr/bin/git', ['cat-file', '-e', `${targetCommitSha}^{commit}`], {cwd: repoDir});
    const info = run('/usr/bin/git', ['log', '-1', '--format=%cI%n%s', targetCommitSha], {cwd: repoDir}).trim().split('\n');
    commitDate = info[0] || null;
    commitMessage = info.slice(1).join(' ') || null;
  } catch {
    setStage('failed', {status: 'failed', errorCode: 'commit_not_found'});
    return;
  }

  setStage('fetching', {targetCommitDate: commitDate, targetMessage: commitMessage});

  // 2. Stage: Verifying
  setStage('verifying', {targetCommitDate: commitDate, targetMessage: commitMessage});
  const verifyDir = fs.mkdtempSync('/var/lib/tma-deploy/.verify-');
  try {
    // Extract exact commit snapshot
    const archive = run('/usr/bin/git', ['archive', '--format=tar', targetCommitSha], {cwd: repoDir, encoding: 'buffer'});
    run('/usr/bin/tar', ['-xf', '-'], {cwd: verifyDir, input: archive});

    const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
    // Run verification gates
    const mise = path.join(process.env.HOME ?? '/home/ubuntu', '.local/bin/mise');
    const hasMise = fs.existsSync(mise);
    const execCmd = hasMise ? mise : 'npm';
    const miseArgs = sub => hasMise ? ['run', sub] : ['run', sub];

    if (hasMise) {
      run(mise, ['trust'], {cwd: verifyDir});
      run(mise, ['exec', '--', 'bash', '-c', 'cd collector && go test ./... && go vet ./...'], {cwd: verifyDir});
      run(mise, ['exec', '--', 'npm', '--prefix', 'analytics', 'test'], {cwd: verifyDir});
      run(mise, ['exec', '--', 'npm', '--prefix', 'analytics', 'run', 'typecheck'], {cwd: verifyDir});
      run(mise, ['exec', '--', 'node', '--experimental-strip-types', 'tools/integration.mjs'], {cwd: verifyDir});
      run(mise, ['run', `release:ubuntu:${architecture}`], {cwd: verifyDir});
    } else {
      // Fallback if mise wrapper not present in path
      run('go', ['test', './...'], {cwd: path.join(verifyDir, 'collector')});
      run('go', ['vet', './...'], {cwd: path.join(verifyDir, 'collector')});
      run('npm', ['--prefix', 'analytics', 'test'], {cwd: verifyDir});
      run('node', ['--experimental-strip-types', 'tools/integration.mjs'], {cwd: verifyDir});
    }

    // 3. Stage: Deploying & Restarting
    setStage('deploying', {targetCommitDate: commitDate, targetMessage: commitMessage});

    const publishScript = path.join(verifyDir, 'tools/publish-ubuntu.mjs');
    const nodeBin = process.execPath;
    run(nodeBin, [
      '--experimental-strip-types',
      publishScript,
      '--apply',
      '--commit-sha',
      targetCommitSha,
      '--commit-date',
      commitDate ?? ''
    ], {cwd: verifyDir});

    // 4. Stage: Success
    setStage('success', {status: 'completed', targetCommitDate: commitDate, targetMessage: commitMessage});
  } catch (err) {
    // If deploy failed after stopping services or verifying
    setStage('failed', {status: 'failed', errorCode: 'verification_failed', targetCommitDate: commitDate, targetMessage: commitMessage});
  } finally {
    fs.rmSync(verifyDir, {recursive: true, force: true});
  }
}

async function main() {
  userEnvironment();
  const lockFile = '/var/lib/tma-lock/deploy.lock';
  // Non-blocking flock to avoid conflicting with manual CLI publish
  try {
    inherit('/usr/bin/flock', ['--nonblock', '-E', '75', lockFile, process.execPath, '--experimental-strip-types', fileURLToPath(import.meta.url), '--apply'], {lock: true});
  } catch (err) {
    // If lock held by another process, record lock_conflict in update-state.json
    const state = readUpdateState(updateStateFile, {checkServiceActive: () => false});
    if (state && state.status === 'running') {
      saveUpdateState(updateStateFile, {
        ...state,
        status: 'failed',
        stage: 'failed',
        errorCode: 'lock_conflict',
        finishedAt: new Date().toISOString()
      });
    }
    throw err;
  }
}

if (process.argv.includes('--apply')) {
  runUpdate().catch(err => {
    const state = readUpdateState(updateStateFile, {checkServiceActive: () => false});
    if (state && state.status === 'running') {
      saveUpdateState(updateStateFile, {
        ...state,
        status: 'failed',
        stage: 'failed',
        errorCode: 'unknown_error',
        finishedAt: new Date().toISOString()
      });
    }
    report(err);
  });
} else {
  main().catch(report);
}
