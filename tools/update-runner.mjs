import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readRunnerState, saveRunnerState, isTerminalState, normalizeFailedStage} from './update-runner-state.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const BRANCH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export const DEFAULT_RUNNER_PATHS = Object.freeze({
  statePath: '/var/lib/tma-deploy/update-state.json',
  repositoryPath: '/var/lib/tma-deploy/repo',
  verifyRoot: '/var/lib/tma-deploy/verify',
  lockPath: '/var/lib/tma-lock/deploy.lock',
  infrastructurePath: '/etc/token-monitor-analytics/infrastructure.json',
  configPath: '/var/lib/tma-deploy/config/analytics.json',
  secretsPath: '/var/lib/tma-deploy/config/hub-secrets.json',
  databasePath: '/var/lib/tma-analytics/analytics.db',
  backupPath: '/var/lib/tma-analytics/backups',
  prefix: '/opt/token-monitor-analytics',
  currentLink: '/opt/token-monitor-analytics/current',
  publicationPath: '/opt/token-monitor-analytics/publication.json',
  appUnit: 'tma-analytics.service',
  updateUnit: 'tma-update.service'
});

function safeError(message, code) {
  return Object.assign(new Error(message), {code});
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options});
  } catch {
    throw safeError(`${path.basename(command)} failed; sensitive output suppressed.`, 'runner_command_failed');
  }
}

function readPrivateJSON(filename, label) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw safeError(`${label} is missing.`, 'configuration_required'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw safeError(`${label} is not a regular file.`, 'configuration_required');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw safeError(`${label} is invalid.`, 'configuration_required'); }
}

function validateRepository(repositoryUrl, branch) {
  if (typeof repositoryUrl !== 'string' || !repositoryUrl || /[\r\n\0]/.test(repositoryUrl)) throw safeError('The update job has no valid repository.', 'configuration_required');
  let url;
  try { url = new URL(repositoryUrl); } catch { throw safeError('The update repository is invalid.', 'configuration_required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw safeError('The update repository must be an HTTPS origin without credentials.', 'configuration_required');
  if (typeof branch !== 'string' || !BRANCH.test(branch) || branch.startsWith('/') || branch.endsWith('/')) throw safeError('The update branch is invalid.', 'configuration_required');
}

function git(command, args, options = {}) { return run('/usr/bin/git', [command, ...args], options); }
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw safeError('The update working directory is not private.', 'configuration_required');
}

function createRepositoryOps({repositoryPath}) {
  return {
    prepare({repositoryUrl, branch, targetCommitSha, workRoot}) {
      validateRepository(repositoryUrl, branch);
      ensurePrivateDirectory(repositoryPath);
      const bare = fs.existsSync(path.join(repositoryPath, 'HEAD')) && fs.existsSync(path.join(repositoryPath, 'objects'));
      if (!bare) {
        if (fs.readdirSync(repositoryPath).length) throw safeError('The update repository directory is not an empty Git repository.', 'fetch_failed');
        git('init', ['--bare', repositoryPath]);
      }
      try { git('remote', ['set-url', 'origin', repositoryUrl], {cwd: repositoryPath}); }
      catch { git('remote', ['add', 'origin', repositoryUrl], {cwd: repositoryPath}); }
      try { git('fetch', ['--prune', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {cwd: repositoryPath}); }
      catch { throw safeError('The requested branch could not be fetched.', 'fetch_failed'); }
      let branchSha;
      try { branchSha = git('rev-parse', [`refs/remotes/origin/${branch}`], {cwd: repositoryPath}).trim().toLowerCase(); }
      catch { throw safeError('The requested branch was not found.', 'commit_not_found'); }
      if (branchSha !== targetCommitSha.toLowerCase()) throw safeError('The requested SHA is no longer the branch tip.', 'main_moved');
      try { git('cat-file', ['-e', `${targetCommitSha}^{commit}`], {cwd: repositoryPath}); }
      catch { throw safeError('The requested commit was not found.', 'commit_not_found'); }
      let info;
      try { info = git('log', ['-1', '--format=%cI%n%s', targetCommitSha], {cwd: repositoryPath}).trim().split('\n'); }
      catch { throw safeError('The requested commit metadata could not be read.', 'commit_not_found'); }
      const snapshotDirectory = path.join(workRoot, 'source');
      ensurePrivateDirectory(snapshotDirectory);
      try {
        git('worktree', ['prune'], {cwd: repositoryPath});
        git('worktree', ['add', '--detach', '--force', snapshotDirectory, targetCommitSha], {cwd: repositoryPath});
      }
      catch { throw safeError('The requested source snapshot could not be extracted.', 'verification_failed'); }
      return {
        snapshotDirectory,
        commitDate: info[0] || null,
        commitMessage: info.slice(1).join(' ') || null,
        branchSha,
        cleanup() {
          try { git('worktree', ['remove', '--force', snapshotDirectory], {cwd: repositoryPath}); } catch {}
          fs.rmSync(snapshotDirectory, {recursive: true, force: true});
        }
      };
    }
  };
}

function loadJSONIfPresent(filename) {
  if (!filename || !fs.existsSync(filename)) return null;
  try { return readPrivateJSON(filename, 'Publication metadata'); } catch { return null; }
}

function publicationMetadata(filename) {
  const raw = loadJSONIfPresent(filename);
  if (!raw || typeof raw !== 'object') return null;
  return {
    releaseId: typeof raw.releaseId === 'string' ? raw.releaseId : null,
    configurationId: typeof raw.configurationId === 'string' ? raw.configurationId : null,
    commitSha: typeof raw.commitSha === 'string' ? raw.commitSha : (typeof raw.targetCommitSha === 'string' ? raw.targetCommitSha : null),
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    archiveSha256: typeof raw.archiveSha256 === 'string' ? raw.archiveSha256 : null
  };
}

async function loadRunnerContract(modulePath) {
  if (!modulePath) throw safeError('The fixed runner contract is missing.', 'migration_required');
  let contract;
  try { contract = await import(pathToFileURL(modulePath).href); }
  catch { throw safeError('The fixed runner contract could not be loaded.', 'migration_required'); }
  if (typeof contract.validateRunnerContract !== 'function') throw safeError('The fixed runner contract is incomplete.', 'migration_required');
  try { contract.validateRunnerContract(contract.RUNNER_CONTRACT ?? {}, {nodeVersion: process.versions.node}); }
  catch (error) { throw Object.assign(safeError(error?.message || 'The runner contract is incompatible.', error?.code || 'migration_required'), {cause: error}); }
  return contract;
}

async function loadPublicationApi(modulePath) {
  if (!modulePath) throw safeError('The fixed publication tool is missing.', 'provision_required');
  let publication;
  try { publication = await import(pathToFileURL(modulePath).href); }
  catch { throw safeError('The fixed publication tool could not be loaded.', 'provision_required'); }
  if (typeof publication.preparePublication !== 'function' || typeof publication.applyPublication !== 'function') throw safeError('The installed publication tool does not provide the verified publication contract.', 'migration_required');
  return publication;
}

function defaultPreflight({misePath}) {
  if (!misePath || !fs.existsSync(misePath)) throw safeError('The fixed mise tool is missing; run provision:ubuntu.', 'provision_required');
  try { execFileSync(misePath, ['--version'], {stdio: ['ignore', 'pipe', 'pipe']}); }
  catch { throw safeError('The fixed mise tool cannot run; run provision:ubuntu.', 'provision_required'); }
}

function artifactInfo(prepared, targetCommitSha, workRoot, runnerContract) {
  const artifact = prepared?.artifact;
  const manifest = prepared?.manifest ?? artifact?.manifest;
  if (!artifact || !manifest || manifest.targetCommitSha !== targetCommitSha) throw safeError('The publication tool did not return a verified target artifact.', 'verification_failed');
  const artifactPath = typeof artifact.archivePath === 'string' ? path.resolve(artifact.archivePath) : null;
  if (!artifactPath || !fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile()) throw safeError('The verified release archive is missing.', 'verification_failed');
  const root = `${path.resolve(workRoot)}${path.sep}`;
  if (!artifactPath.startsWith(root)) throw safeError('The release archive escaped the private verification directory.', 'verification_failed');
  if (!HASH.test(artifact.archiveSha256 || '') || !HASH.test(manifest.contentHash || '') || typeof manifest.releaseId !== 'string' || !manifest.releaseId) throw safeError('The verified release metadata is incomplete.', 'verification_failed');
  if (!manifest.runtimeContract || typeof runnerContract?.validateRunnerContract !== 'function') throw safeError('The verified release has no compatible runtime contract.', 'migration_required');
  try {
    runnerContract.validateRunnerContract(manifest.runtimeContract, {nodeVersion: process.versions.node});
  } catch (error) {
    throw Object.assign(safeError(error?.message || 'The verified release runtime contract is incompatible.', error?.code || 'migration_required'), {cause: error});
  }
  return {artifactPath, checksumPath: typeof artifact.checksumPath === 'string' ? path.resolve(artifact.checksumPath) : `${artifactPath}.sha256`, archiveSha256: artifact.archiveSha256, contentHash: manifest.contentHash, releaseId: manifest.releaseId, manifest};
}

function publicationProof(result, expected, jobId) {
  const proof = result?.proof && typeof result.proof === 'object' ? result.proof : result;
  if (!proof || proof.jobId !== jobId) throw safeError('The publication result belongs to another update job.', 'health_check_failed');
  if (result?.changed === false) {
    // A verified target can have the same payload/configuration as the live
    // release while carrying a newer Git SHA. The publisher must report both
    // identities; accept the no-op only when its requested manifest is the
    // verified target and its live proof remains internally consistent.
    const requested = result.requestedManifest;
    if (!requested || requested.targetCommitSha !== expected.targetCommitSha || requested.releaseId !== expected.releaseId || requested.contentHash !== expected.contentHash) throw safeError('The no-op publication result does not describe the verified target.', 'health_check_failed');
    if (!SHA.test(proof.commitSha || '') || !HASH.test(proof.archiveSha256 || '') || proof.contentHash !== expected.contentHash || typeof proof.releaseId !== 'string' || !proof.releaseId) throw safeError('The unchanged application did not prove its live release.', 'health_check_failed');
  } else if (proof.commitSha !== expected.targetCommitSha || proof.releaseId !== expected.releaseId || proof.contentHash !== expected.contentHash || proof.archiveSha256 !== expected.archiveSha256) throw safeError('The restarted application did not prove the expected release.', 'health_check_failed');
  if (proof.health !== true || proof.state !== true || proof.viewer !== true || proof.sse !== true) throw safeError('The restarted application did not pass the required viewer/state/SSE checks.', 'health_check_failed');
  return proof;
}

function failureCode(error, stage) {
  if (typeof error?.code === 'string' && ['lock_conflict', 'lock_error', 'fetch_failed', 'main_moved', 'commit_not_found', 'verification_failed', 'provision_required', 'migration_required', 'configuration_required', 'configuration_changed', 'deploy_failed', 'health_check_failed', 'job_aborted', 'save_state_failed', 'runner_command_failed'].includes(error.code)) return error.code;
  if (stage === 'verifying') return 'verification_failed';
  if (stage === 'restarting') return 'health_check_failed';
  if (stage === 'deploying') return 'deploy_failed';
  return 'unknown_error';
}

/** Run one update after the caller has acquired the shared publication lock. */
export async function runUpdate({
  paths: providedPaths = {},
  now = () => new Date().toISOString(),
  checkServiceActive = () => true,
  contractModulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner-contract.mjs'),
  publicationModulePath = null,
  misePath = path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'mise'),
  preflight = defaultPreflight,
  repositoryOps,
  services = null,
  enforceInfrastructure = true
} = {}) {
  const paths = {...DEFAULT_RUNNER_PATHS, ...providedPaths};
  const state = readRunnerState(paths.statePath, {checkServiceActive, now});
  if (!state || state.status !== 'running') return null;
  const {jobId, targetCommitSha} = state;
  if (!SHA.test(targetCommitSha)) {
    saveRunnerState(paths.statePath, {...state, status: 'failed', stage: 'failed', failedStage: normalizeFailedStage(state.stage), errorCode: 'configuration_required', finishedAt: now()});
    return null;
  }
  const setStage = (stage, fields = {}) => {
    const latest = readRunnerState(paths.statePath, {checkServiceActive: () => true, now});
    // Latest-wins state semantics: a newer job or a missing state file must
    // never be overwritten by an older runner that is still unwinding.
    if (!latest || latest.jobId !== jobId || isTerminalState(latest)) return false;
    saveRunnerState(paths.statePath, {...latest, ...fields, jobId, targetCommitSha, stage, status: fields.status ?? 'running', finishedAt: fields.status && fields.status !== 'running' ? (fields.finishedAt ?? now()) : null});
    return true;
  };

  let stage = 'accepted';
  let workRoot = null;
  let sourceCleanup = null;
  try {
    const runnerContract = await loadRunnerContract(contractModulePath);
    if (enforceInfrastructure) {
      const infrastructure = readPrivateJSON(paths.infrastructurePath, 'Infrastructure record');
      if (!infrastructure || typeof infrastructure !== 'object' || infrastructure.version === undefined) throw safeError('Infrastructure record is incomplete.', 'migration_required');
      try {
        if (typeof runnerContract.validateInfrastructureRecord === 'function') runnerContract.validateInfrastructureRecord(infrastructure, {nodeVersion: process.versions.node});
        else if (infrastructure.runtimeContract || infrastructure.runnerContract || infrastructure.configVersion !== undefined) runnerContract.validateRunnerContract(infrastructure.runtimeContract ?? infrastructure.runnerContract ?? infrastructure, {nodeVersion: process.versions.node});
        else throw safeError('Infrastructure record has no runner contract.', 'migration_required');
      } catch (error) {
        throw Object.assign(safeError(error?.message || 'Infrastructure requires a newer provision step.', error?.code || 'migration_required'), {cause: error});
      }
    }
    if (!state.repositoryUrl || !state.branch) throw safeError('The update job has no repository snapshot information.', 'configuration_required');
    validateRepository(state.repositoryUrl, state.branch);
    const before = publicationMetadata(paths.publicationPath);
    if (state.initialConfigurationId && before?.configurationId && state.initialConfigurationId !== before.configurationId) throw safeError('Application configuration changed after the update was accepted.', 'configuration_changed');

    ensurePrivateDirectory(paths.verifyRoot);
    workRoot = fs.mkdtempSync(path.join(paths.verifyRoot, `.job-${jobId}-`));
    fs.chmodSync(workRoot, 0o700);
    stage = 'fetching';
    if (!setStage(stage)) return null;
    const repository = repositoryOps ?? createRepositoryOps({repositoryPath: paths.repositoryPath});
    const source = await repository.prepare({repositoryUrl: state.repositoryUrl, branch: state.branch, targetCommitSha: targetCommitSha.toLowerCase(), workRoot});
    sourceCleanup = typeof source.cleanup === 'function' ? source.cleanup : null;
    const commitDate = source.commitDate ?? state.targetCommitDate;
    const commitMessage = source.commitMessage ?? state.targetMessage;
    if (source.branchSha && source.branchSha.toLowerCase() !== targetCommitSha.toLowerCase()) throw safeError('The requested SHA is no longer the branch tip.', 'main_moved');
    setStage('fetching', {targetCommitDate: commitDate, targetMessage: commitMessage});

    stage = 'verifying';
    if (!setStage(stage, {targetCommitDate: commitDate, targetMessage: commitMessage})) return null;
    await preflight({misePath, architecture: process.arch === 'x64' ? 'amd64' : 'arm64', targetCommitSha, sourceDirectory: source.snapshotDirectory});
    // The updater itself is a fixed, tiny bootstrap. The publication API is
    // loaded only after the target source tree has been fetched and verified,
    // so a stale copy from the live updater checkout cannot publish anything.
    const sourcePublicationModulePath = publicationModulePath
      ? path.resolve(publicationModulePath)
      : path.join(source.snapshotDirectory, 'tools', 'publish-ubuntu.mjs');
    const publication = await loadPublicationApi(sourcePublicationModulePath);
    const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
    const prepareOptions = {
      root: source.snapshotDirectory,
      architecture,
      targetCommitSha: targetCommitSha.toLowerCase(),
      configDir: path.dirname(paths.configPath),
      infrastructurePath: paths.infrastructurePath,
      current: paths.currentLink,
      publicationPath: paths.publicationPath,
      uid: process.getuid?.(),
      serviceUnits: [paths.appUnit, paths.updateUnit]
    };
    if (services) prepareOptions.services = services;
    const prepared = await publication.preparePublication(prepareOptions);
    const artifact = artifactInfo(prepared, targetCommitSha.toLowerCase(), workRoot, runnerContract);
    setStage('verifying', {targetCommitDate: commitDate, targetMessage: commitMessage, expectedReleaseId: artifact.releaseId, contentHash: artifact.contentHash, archiveSha256: artifact.archiveSha256});

    stage = 'deploying';
    if (!setStage(stage, {expectedReleaseId: artifact.releaseId, contentHash: artifact.contentHash, archiveSha256: artifact.archiveSha256})) return null;
    const applyOptions = {
      jobId,
      targetCommitSha: targetCommitSha.toLowerCase(),
      targetCommitDate: commitDate,
      paths,
      onStage: nextStage => {
        if (nextStage === 'restarting') {
          stage = 'restarting';
          setStage('restarting', {expectedReleaseId: artifact.releaseId, contentHash: artifact.contentHash, archiveSha256: artifact.archiveSha256});
        }
      }
    };
    if (services) applyOptions.services = services;
    const result = await publication.applyPublication(prepared, applyOptions);
    const proof = publicationProof(result, {targetCommitSha: targetCommitSha.toLowerCase(), releaseId: artifact.releaseId, contentHash: artifact.contentHash, archiveSha256: artifact.archiveSha256}, jobId);
    setStage('success', {status: 'completed', outcome: result?.changed === false ? 'unchanged' : 'updated', expectedReleaseId: artifact.releaseId, contentHash: artifact.contentHash, archiveSha256: artifact.archiveSha256, configurationId: proof.configurationId ?? null, finishedAt: now()});
    return {jobId, targetCommitSha: targetCommitSha.toLowerCase(), releaseId: artifact.releaseId, proof};
  } catch (error) {
    const code = failureCode(error, stage);
    try {
      const latest = readRunnerState(paths.statePath, {checkServiceActive: () => true, now});
      if (latest?.jobId === jobId && !isTerminalState(latest)) saveRunnerState(paths.statePath, {...latest, status: 'failed', stage: 'failed', failedStage: latest.failedStage ?? normalizeFailedStage(stage), errorCode: code, finishedAt: now()});
    } catch {}
    return {jobId, targetCommitSha, errorCode: code};
  } finally {
    try { sourceCleanup?.(); } catch {}
    if (workRoot) fs.rmSync(workRoot, {recursive: true, force: true});
  }
}

function userEnvironment() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw safeError('Run the update runner as the configured ordinary Ubuntu user.', 'configuration_required');
  process.env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid()}`;
  process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
}

/**
 * Acquire the shared deployment lock in this process. The helper flock child
 * locks descriptor 3, whose open-file description remains live in the parent
 * after the child exits. Keeping that descriptor open through the entire
 * async update closes the race in which a probe merely observes somebody
 * else's lock and then runs without owning one.
 */
export function acquirePublicationLock(lockPath) {
  const filename = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
  if (process.platform === 'linux') {
    let handle;
    try {
      const stat = fs.existsSync(filename) ? fs.lstatSync(filename) : null;
      if (stat?.isSymbolicLink()) throw safeError('The deployment lock path is a symbolic link.', 'lock_error');
      handle = fs.openSync(filename, 'a+', 0o600);
      const result = spawnSync('/usr/bin/flock', ['-n', '3'], {stdio: ['ignore', 'ignore', 'ignore', handle]});
      if (result.error || result.status !== 0) {
        fs.closeSync(handle);
        handle = undefined;
        throw safeError(result.status === 1 ? 'Another publication operation holds the deployment lock.' : 'Cannot acquire the deployment lock.', result.status === 1 ? 'lock_conflict' : 'lock_error');
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.closeSync(handle);
      };
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
      }
      throw error;
    }
  }
  // The runner is installed on Ubuntu. Keep a small local fallback so the
  // helper remains deterministic for development tooling on Windows.
  let handle;
  try { handle = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw safeError('Another publication operation holds the deployment lock.', 'lock_conflict');
    throw safeError('Cannot acquire the deployment lock.', 'lock_error');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(handle);
    fs.rmSync(filename, {force: true});
  };
}

async function main() {
  userEnvironment();
  const releaseLock = acquirePublicationLock(DEFAULT_RUNNER_PATHS.lockPath);
  try {
    const result = await runUpdate();
    if (result?.errorCode) throw safeError('The update runner failed.', result.errorCode);
  } finally {
    releaseLock();
  }
}

function report(error) {
  if (error?.code === 'lock_conflict') console.error('Another publication operation holds the deployment lock.');
  else console.error(error?.message || 'The update runner failed.');
  process.exitCode = 1;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  if (process.argv.includes('--locked')) report(safeError('The update runner does not accept an externally inherited lock.', 'lock_conflict'));
  else main().catch(report);
}
