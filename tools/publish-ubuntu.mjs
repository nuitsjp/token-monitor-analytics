import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {destination,appUnits,managedUnits,currentDir,releasesDir,updaterDir,infrastructureFile,deploymentLock,publicationFile,validateInfrastructure,assertInfrastructureFile,userUnit,unitDigest,runtimeContract} from './ubuntu-layout.mjs';
import {readJSON,selectConfiguration,validateConfiguration,readPublication,writeChanged,configurationId,assertOldLayout} from './publish-config.mjs';
import {createReleaseArtifact,verifyReleaseArtifact,runReleaseVerification,readManifest,treeDigest,releaseContentHash,gitRevision,assertPinnedSource as assertReleaseSource} from './release.mjs';
import {RUNNER_CONTRACT,validateRunnerContract} from './runner-contract.mjs';
import {userEnvironment,report} from './ubuntu-common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeVersioned = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

function run(command, args, options = {}) {
  try { return execFileSync(command, args, {encoding: 'utf8', stdio: 'pipe', ...options}); }
  catch { throw Object.assign(new Error(`${path.basename(command)} failed; inspect the host configuration locally (command output suppressed).`), {code: 'host_command_failed'}); }
}

function serviceController(overrides = {}) {
  const ctl = (...args) => run('/usr/bin/systemctl', ['--user', ...args]);
  return {
    isActive: overrides.isActive ?? (name => spawnSync('/usr/bin/systemctl', ['--user', 'is-active', '--quiet', name]).status === 0),
    isEnabled: overrides.isEnabled ?? (name => spawnSync('/usr/bin/systemctl', ['--user', 'is-enabled', '--quiet', name]).status === 0),
    stop: overrides.stop ?? (name => ctl('stop', name)),
    start: overrides.start ?? (name => ctl('start', name)),
    restart: overrides.restart ?? (name => ctl('restart', name)),
    daemonReload: overrides.daemonReload ?? (() => ctl('daemon-reload')),
    installUnit: overrides.installUnit ?? (() => {})
  };
}

function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular deployment file.');
}

function configSnapshot(selected) {
  const names = [selected.analyticsConfig, selected.analyticsEnv, selected.hubSecrets].filter(Boolean);
  return names.map(filename => {
    try {
      const stat = fs.statSync(filename);
      return {filename, size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(filename)};
    } catch { return {filename, missing: true}; }
  });
}

function snapshotEqual(before, after) {
  if (before.length !== after.length) return false;
  return before.every((left, index) => {
    const right = after[index];
    return left.filename === right.filename && left.missing === right.missing && left.size === right.size && left.mtimeMs === right.mtimeMs && (left.bytes?.equals(right.bytes) ?? true);
  });
}

function currentReleaseProof(current, publication, configurationIdValue) {
  try {
    const stat = fs.lstatSync(current);
    if (!stat.isSymbolicLink()) return false;
    const directory = fs.realpathSync(current);
    const manifest = readManifest(directory);
    if (!manifest || manifest.releaseId !== publication?.releaseId || manifest.contentHash !== publication?.contentHash || publication?.configurationId !== configurationIdValue) return false;
    return manifest.contentHash === treeDigest(directory, {exclude: ['release-manifest.json', 'node']});
  } catch { return false; }
}

function currentReleaseManifest(current) {
  try {
    const stat = fs.lstatSync(current);
    if (!stat.isSymbolicLink()) return null;
    return readManifest(fs.realpathSync(current));
  } catch { return null; }
}

function copyTree(source, target) {
  fs.mkdirSync(target, {recursive: true, mode: 0o755});
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(target, name), stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile() && !stat.isSymbolicLink()) { fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644); }
    else throw new Error(`Release contains a non-regular file: ${name}`);
  }
}

/**
 * Perform all read-only checks before stop/backup. The returned object is the
 * only input accepted by applyPublication, making a stale/unverified artifact
 * impossible to pass through the application path.
 */
export async function preparePublication({
  root: sourceRoot = root,
  architecture = process.arch === 'arm64' ? 'arm64' : 'amd64',
  targetCommitSha,
  sourceProof,
  artifactPath,
  checksumPath,
  configDir = destination,
  infrastructurePath = infrastructureFile,
  current = currentDir,
  publicationPath = publicationFile,
  uid = process.getuid?.(),
  expectedPublicOrigin,
  serviceUnits = managedUnits,
  runtime = runtimeContract(),
  services = serviceController()
} = {}) {
  const configRoot = path.resolve(configDir);
  // This check intentionally precedes any service operation and backup.
  assertOldLayout({root: path.dirname(path.resolve(current)), destination: configRoot, currentDir: current});
  const selectedInfrastructurePath = configRoot === path.resolve(destination) ? infrastructurePath : null;
  const infrastructure = selectedInfrastructurePath && fs.existsSync(selectedInfrastructurePath) ? readJSON(selectedInfrastructurePath) : null;
  if (infrastructure && uid !== undefined && selectedInfrastructurePath === infrastructureFile) {
    assertInfrastructureFile(selectedInfrastructurePath);
    validateInfrastructure(infrastructure, uid);
  }
  if (configRoot === path.resolve(destination)) {
    const fixedNode = path.join(updaterDir, 'node');
    try {
      const stat = fs.lstatSync(fixedNode);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('fixed Node is not a regular file');
    } catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error('Fixed Node is missing; run provision:ubuntu before publication'), {code: 'provision_required'});
      throw error;
    }
  }
  const selected = selectConfiguration({}, configRoot);
  for (const filename of [selected.analyticsConfig, selected.analyticsEnv, selected.hubSecrets].filter(Boolean)) if (fs.existsSync(filename)) regular(filename);
  const validated = validateConfiguration({}, selected);
  if (expectedPublicOrigin && validated.analytics.publicOrigin !== expectedPublicOrigin) throw new Error('Configured publicOrigin does not match the expected publication origin');
  selected.hubSecrets = validated.hubSecretsPath;
  // Capture the exact startup files together with the parsed configuration,
  // before any potentially long release verification begins.
  const snapshot = configSnapshot(selected);
  validateRunnerContract(runtime);

  const pinnedSha = targetCommitSha ?? gitRevision(sourceRoot);
  let artifact;
  let ownedArtifact = false;
  if (artifactPath) {
    // A release-level manifest is only an assertion. On a real installation,
    // bind the archive to the clean pinned source tree and rerun the same
    // release gate before trusting it; package-only archives cannot enter this
    // path. Temporary fixture destinations intentionally use the lower-level
    // API without making a production certification claim.
    if (configRoot === path.resolve(destination)) {
      assertReleaseSource(sourceRoot, pinnedSha, sourceProof);
      const sourceHash = releaseContentHash(sourceRoot);
      artifact = verifyReleaseArtifact({archivePath: artifactPath, checksumPath, expectedTargetCommitSha: pinnedSha, expectedContentHash: sourceHash, expectedArchitecture: architecture});
      runReleaseVerification(sourceRoot);
    } else artifact = verifyReleaseArtifact({archivePath: artifactPath, checksumPath, expectedTargetCommitSha: pinnedSha, expectedArchitecture: architecture});
  }
  else {
    assertReleaseSource(sourceRoot, pinnedSha, sourceProof);
    if (!pinnedSha) throw new Error('A full pinned commit SHA is required for publication');
    const checks = runReleaseVerification(sourceRoot);
    const built = createReleaseArtifact({root: sourceRoot, architecture, outputDir: path.join(sourceRoot, 'dist'), targetCommitSha: pinnedSha, certified: true, verification: {level: 'release', checks}});
    artifact = verifyReleaseArtifact({archivePath: built.archivePath, checksumPath: built.checksumPath, expectedTargetCommitSha: pinnedSha, expectedArchitecture: architecture});
    ownedArtifact = true;
  }
  if (!/^[0-9a-f]{40}$/i.test(artifact.manifest.targetCommitSha ?? '')) throw new Error('Only a release artifact with a full pinned target SHA may be published');
  if (artifact.manifest.verification?.level !== 'release') throw new Error('Artifact has only package verification; run the full release verification gate before publication');
  validateRunnerContract(artifact.manifest.runtimeContract);
  if (artifact.temporaryDirectory) fs.rmSync(artifact.directory, {recursive: true, force: true});
  if (!snapshotEqual(snapshot, configSnapshot(selected))) throw new Error('Configuration changed during publication verification; retry before stopping Analytics');
  const serviceDefinitions = [...serviceUnits].map(name => managedUnits.includes(name) ? userUnit(name) : name);
  const cfgId = configurationId({config: validated.analytics, environment: validated.analyticsEnv, serviceUnits: serviceDefinitions, runtimeContract: runtime});
  const publication = readPublication(publicationPath);
  const runningManifest = currentReleaseManifest(current);
  const sameContent = runningManifest?.contentHash === artifact.manifest.contentHash && publication?.contentHash === runningManifest.contentHash && publication?.configurationId === cfgId && currentReleaseProof(current, publication, cfgId) && Boolean(services.isActive('tma-analytics.service')) && Boolean(services.isEnabled('tma-analytics.service'));
  return {
    artifact,
    ownedArtifact,
    manifest: artifact.manifest,
    config: validated,
    selected,
    configurationId: cfgId,
    publication,
    runningManifest,
    sameContent,
    snapshot,
    configDir: configRoot,
    currentDir: path.resolve(current),
    releasesDir: path.resolve(path.dirname(current), 'releases'),
    publicationPath,
    infrastructure,
    serviceUnits: [...serviceUnits],
    runtimeContract: runtime,
    services
  };
}

async function defaultHealthCheck(config, {expectedRelease, fetchImpl = fetch, timeoutMs = 10000} = {}) {
  const authenticated = config.auth?.user ? {Authorization: `Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString('base64')}`} : {};
  const deadline = Date.now() + timeoutMs;
  const retry = async (operation, label) => {
    let lastError = new Error(`${label} verification timed out`);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      try { return await operation(remaining); }
      catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      }
    }
    throw lastError;
  };
  const request = async (route, headers = authenticated) => retry(async remaining => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetchImpl(config.analytics.publicOrigin + route, {headers, signal: controller.signal});
      const contentType = response.headers.get('content-type') ?? '';
      let body;
      try { body = contentType.includes('json') ? await response.json() : await response.text(); }
      catch (error) { throw Object.assign(new Error(`${route} returned an invalid response`), {cause: error}); }
      // Startup connection errors and transient server responses are retried
      // until the single health deadline. Stable 4xx responses are returned so
      // the authentication and removed-route checks fail immediately.
      if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error(`${route} is not ready (${response.status})`);
      return {response, body};
    } finally { clearTimeout(timer); }
  }, `Analytics ${route}`);
  const readLive = () => retry(async remaining => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let reader;
    try {
      const response = await fetchImpl(config.analytics.publicOrigin + '/api/live', {headers: authenticated, signal: controller.signal});
      if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error(`Analytics SSE is not ready (${response.status})`);
      if (response.status !== 200 || !response.body) throw new Error('Published Analytics SSE verification failed');
      reader = response.body.getReader(); let text = '';
      while (!text.includes('event: ready')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Published Analytics SSE ended before ready');
        text += new TextDecoder().decode(chunk.value, {stream: true});
        if (text.length > 1024 * 1024) throw new Error('Published Analytics SSE response is too large');
      }
      return true;
    } finally {
      try { await reader?.cancel(); } catch {}
      clearTimeout(timer);
    }
  }, 'Analytics SSE');
  const health = await request('/api/health', {});
  if (health.response.status !== 200 || health.body?.ok !== true) throw new Error('Published Analytics health verification failed');
  if (expectedRelease && (health.body?.release?.releaseId !== expectedRelease.releaseId || health.body?.release?.targetCommitSha !== expectedRelease.targetCommitSha || health.body?.release?.contentHash !== expectedRelease.contentHash)) throw new Error('Published Analytics health release identity does not match the verified artifact');
  const assertRelease = body => {
    if (!expectedRelease || body?.release?.releaseId !== expectedRelease.releaseId || body.release.targetCommitSha !== expectedRelease.targetCommitSha || body.release.contentHash !== expectedRelease.contentHash) throw new Error('Published Analytics release identity does not match the verified artifact');
  };
  if (config.analytics.viewerAuth.mode === 'basic') {
    const unauthenticated = await request('/api/state', {});
    if (unauthenticated.response.status !== 401) throw new Error('Basic viewer authentication boundary is not enforced');
  }
  const state = await request('/api/state', authenticated);
  if (state.response.status !== 200 || state.body?.storage !== 'sqlite') throw new Error('Published Analytics state verification failed');
  assertRelease(state.body);
  const ingest = await request('/api/ingest', authenticated);
  const collector = await request('/api/collector/status', authenticated);
  if (ingest.response.status !== 404 || collector.response.status !== 404) throw new Error('Legacy Collector endpoints are still exposed');
  await readLive();
  return {health: true, state: true, viewer: true, sse: true};
}

async function backupDeployment(prepared, backupDirectory) {
  fs.mkdirSync(backupDirectory, {recursive: true, mode: 0o700});
  const databasePath = prepared.config.analytics.databasePath;
  if (fs.existsSync(databasePath)) {
    regular(databasePath);
    const {backupDatabase} = await import('../analytics/runtime/sqlite.mjs');
    await backupDatabase(databasePath, path.join(backupDirectory, 'analytics.db'));
  }
  const configBackup = path.join(backupDirectory, 'config');
  fs.mkdirSync(configBackup, {recursive: true, mode: 0o700});
  for (const filename of [prepared.selected.analyticsConfig, prepared.selected.analyticsEnv, prepared.selected.hubSecrets].filter(Boolean)) if (fs.existsSync(filename)) {
    const target = path.join(configBackup, path.basename(filename));
    fs.copyFileSync(filename, target);
    fs.chmodSync(target, 0o600);
  }
}

/** Apply one already prepared artifact. Same content/config is a no-op. */
export async function applyPublication(prepared, {
  services = prepared.services ?? serviceController(),
  backup = backupDeployment,
  backupDirectory = path.join(path.dirname(prepared.currentDir), 'backups', `${prepared.manifest.releaseId}-${Date.now()}`),
  healthCheck = defaultHealthCheck,
  now = () => new Date().toISOString(),
  writePublication = true,
  jobId = null,
  targetCommitSha = prepared.manifest.targetCommitSha,
  onStage = () => {}
} = {}) {
  if (targetCommitSha && targetCommitSha.toLowerCase() !== String(prepared.manifest.targetCommitSha).toLowerCase()) throw new Error('Publication target SHA does not match the prepared artifact');
  if (!snapshotEqual(prepared.snapshot, configSnapshot(prepared.selected))) throw new Error('Configuration changed during publication preparation; retry before stopping Analytics');
  if (prepared.sameContent) {
    // Preparation happens while the old application is live. Recheck the
    // symlink, publication identity, service state, and viewer boundary before
    // accepting a no-op from a stale prepared object.
    const liveManifest = currentReleaseManifest(prepared.currentDir);
    const stillSame = liveManifest?.contentHash === prepared.manifest.contentHash
      && currentReleaseProof(prepared.currentDir, prepared.publication, prepared.configurationId)
      && Boolean(services.isActive('tma-analytics.service'))
      && Boolean(services.isEnabled('tma-analytics.service'));
    if (stillSame) {
      const health = await healthCheck(prepared.config, {expectedRelease: liveManifest});
      return {
        changed: false,
        restarted: false,
        publication: prepared.publication,
        runningManifest: liveManifest,
        requestedManifest: prepared.manifest,
        proof: {
          jobId,
          commitSha: liveManifest.targetCommitSha,
          releaseId: liveManifest.releaseId,
          contentHash: liveManifest.contentHash,
          archiveSha256: prepared.publication?.archiveSha256 ?? null,
          configurationId: prepared.configurationId,
          health: health?.health ?? true,
          state: health?.state ?? true,
          viewer: health?.viewer ?? true,
          sse: health?.sse ?? true
        }
      };
    }
  }
  // The old-layout guard is repeated immediately before stop in case a legacy
  // file was restored while the archive was being verified.
  assertOldLayout({root: path.dirname(prepared.currentDir), destination: prepared.configDir, currentDir: prepared.currentDir});
  try {
    if (!fs.lstatSync(prepared.currentDir).isSymbolicLink()) throw new Error('Current release path is not a symlink; refusing to replace it');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const finalArtifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-verified-'));
  try {
    const finalArtifact = verifyReleaseArtifact({
      archivePath: prepared.artifact.archivePath,
      checksumPath: prepared.artifact.checksumPath,
      expectedTargetCommitSha: prepared.manifest.targetCommitSha,
      expectedContentHash: prepared.manifest.contentHash,
      expectedArchitecture: prepared.manifest.architecture,
      extractDir: finalArtifactDirectory
    });
    const releaseDir = path.join(prepared.releasesDir, prepared.manifest.releaseId);
    let existingRelease = false;
    if (fs.existsSync(releaseDir)) {
      const stat = fs.lstatSync(releaseDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing release directory is not a safe regular directory');
      const existingManifest = readManifest(releaseDir);
      if (!existingManifest || existingManifest.releaseId !== prepared.manifest.releaseId || existingManifest.contentHash !== prepared.manifest.contentHash || existingManifest.contentHash !== treeDigest(releaseDir, {exclude: ['release-manifest.json', 'node']})) throw new Error('Existing release directory failed content verification');
      existingRelease = true;
    }
    await services.stop('tma-analytics.service');
    if (typeof services.isActive === 'function' && services.isActive('tma-analytics.service')) throw new Error('Analytics service remained active after stop; refusing to back up or replace it');
    await backup(prepared, backupDirectory);
    if (!existingRelease) {
      fs.mkdirSync(prepared.releasesDir, {recursive: true, mode: 0o755});
      copyTree(finalArtifact.directory, releaseDir);
    }
    const fixedNode = path.join(updaterDir, 'node');
    if (fs.existsSync(fixedNode) && !fs.existsSync(path.join(releaseDir, 'node'))) {
      regular(fixedNode);
      fs.copyFileSync(fixedNode, path.join(releaseDir, 'node'));
      fs.chmodSync(path.join(releaseDir, 'node'), 0o755);
    }
    const next = `${prepared.currentDir}.next-${process.pid}`;
    fs.rmSync(next, {recursive: true, force: true});
    fs.symlinkSync(releaseDir, next, 'dir');
    // On Ubuntu rename(2) atomically replaces the current symlink. Never remove
    // a live directory first, because a crash in that gap would lose the app.
    fs.renameSync(next, prepared.currentDir);
    services.installUnit('tma-analytics.service', userUnit('tma-analytics.service'));
    services.daemonReload();
    onStage('restarting');
    await services.start('tma-analytics.service');
    const health = await healthCheck(prepared.config, {expectedRelease: prepared.manifest});
    const record = {
      schemaVersion: 1,
      releaseId: prepared.manifest.releaseId,
      targetCommitSha: prepared.manifest.targetCommitSha,
      targetCommitDate: prepared.manifest.targetCommitDate,
      contentHash: prepared.manifest.contentHash,
      archiveSha256: prepared.artifact.archiveSha256,
      configurationId: prepared.configurationId,
      publicOrigin: prepared.config.analytics.publicOrigin,
      publishedAt: now(),
      runtimeContract: prepared.runtimeContract
    };
    if (writePublication) writeChanged(prepared.publicationPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    return {
      changed: true,
      restarted: true,
      publication: record,
      proof: {
        jobId,
        commitSha: prepared.manifest.targetCommitSha,
        releaseId: prepared.manifest.releaseId,
        contentHash: prepared.manifest.contentHash,
        archiveSha256: prepared.artifact.archiveSha256,
        configurationId: prepared.configurationId,
        health: health?.health ?? true,
        state: health?.state ?? true,
        viewer: health?.viewer ?? true,
        sse: health?.sse ?? true
      }
    };
  } finally {
    fs.rmSync(finalArtifactDirectory, {recursive: true, force: true});
  }
}

export async function publish({lockPath = deploymentLock, ...options} = {}) {
  const {withPublicationLock} = await import('./release.mjs');
  return withPublicationLock(lockPath, async () => {
    const prepared = await preparePublication(options);
    return applyPublication(prepared, options);
  });
}

// Stable names shared with the Issue #26 runner. Keep the older descriptive
// aliases for the CLI tests and migration tooling already in the repository.
export const prepareVerifiedArtifact = preparePublication;
export const publishVerifiedArtifact = applyPublication;

async function main() {
  userEnvironment();
  const {values} = parseArgs({options: {apply: {type: 'boolean'}, architecture: {type: 'string'}, 'artifact-path': {type: 'string'}, 'target-sha': {type: 'string'}, 'locked': {type: 'boolean'}}, strict: true});
  if (!values.apply) throw new Error('Publication requires --apply; preparation and verification are performed in the same command.');
  if (process.getuid?.() === 0) throw new Error('Publish as the configured ordinary user; root publication is prohibited.');
  const result = await publish({architecture: values.architecture, artifactPath: values['artifact-path'], targetCommitSha: values['target-sha'], lockPath: deploymentLock});
  console.log(result.changed ? 'Published verified Analytics release.' : 'SKIP: verified release and startup configuration are unchanged; service was not restarted.');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(report);
