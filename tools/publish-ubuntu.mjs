import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {destination,appUnits,managedUnits,currentDir,releasesDir,infrastructureFile,deploymentLock,publicationFile,validateInfrastructure,assertInfrastructureFile,userUnit,unitDigest,runtimeContract} from './ubuntu-layout.mjs';
import {readJSON,selectConfiguration,validateConfiguration,readPublication,writeChanged,configurationId,assertOldLayout} from './publish-config.mjs';
import {createReleaseArtifact,verifyReleaseArtifact} from './release.mjs';
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

function gitRevision(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return null; }
}

function assertPinnedSource(root, targetCommitSha) {
  const head = gitRevision(root);
  if (!targetCommitSha) return head;
  if (!/^[0-9a-f]{40}$/i.test(targetCommitSha) || head !== targetCommitSha) throw new Error('Publication source is not the requested pinned commit SHA');
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    if (dirty) throw new Error('Publication source has local changes; prepare a clean pinned tree first');
  } catch (error) {
    if (error?.message?.includes('local changes')) throw error;
    throw new Error('Cannot verify the pinned publication tree');
  }
  return targetCommitSha;
}

function snapshotEqual(before, after) {
  if (before.length !== after.length) return false;
  return before.every((left, index) => {
    const right = after[index];
    return left.filename === right.filename && left.missing === right.missing && left.size === right.size && left.mtimeMs === right.mtimeMs && (left.bytes?.equals(right.bytes) ?? true);
  });
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

async function validateAgainstTargetRuntime(configFile, env) {
  const moduleFile = path.join(root, 'analytics/runtime/config.mjs');
  if (!fs.existsSync(moduleFile)) return null;
  const runtime = await import(`${pathToFileURL(moduleFile).href}?publication=${fs.statSync(moduleFile).mtimeMs}`);
  if (typeof runtime.loadConfig !== 'function') throw new Error('Analytics runtime config validator is missing');
  const config = runtime.loadConfig(configFile);
  if (typeof runtime.credentials === 'function') runtime.credentials(config, env);
  return config;
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
  artifactPath,
  checksumPath,
  configDir = destination,
  infrastructurePath = infrastructureFile,
  current = currentDir,
  publicationPath = publicationFile,
  uid = process.getuid?.(),
  expectedPublicOrigin,
  serviceUnits = managedUnits,
  runtime = runtimeContract()
} = {}) {
  const configRoot = path.resolve(configDir);
  // This check intentionally precedes any service operation and backup.
  assertOldLayout({destination: configRoot, currentDir: current});
  const infrastructure = fs.existsSync(infrastructurePath) ? readJSON(infrastructurePath) : null;
  if (infrastructure && uid !== undefined && infrastructurePath === infrastructureFile) {
    assertInfrastructureFile(infrastructurePath);
    validateInfrastructure(infrastructure, uid);
  }
  const selected = selectConfiguration({}, configRoot);
  for (const filename of [selected.analyticsConfig, selected.analyticsEnv, selected.hubSecrets].filter(Boolean)) if (fs.existsSync(filename)) regular(filename);
  const validated = validateConfiguration({}, selected);
  if (expectedPublicOrigin && validated.analytics.publicOrigin !== expectedPublicOrigin) throw new Error('Configured publicOrigin does not match the expected publication origin');
  await validateAgainstTargetRuntime(selected.analyticsConfig, validated.analyticsEnv);
  validateRunnerContract(runtime);

  const pinnedSha = targetCommitSha ?? gitRevision(sourceRoot);
  let artifact;
  let ownedArtifact = false;
  if (artifactPath) artifact = verifyReleaseArtifact({archivePath: artifactPath, checksumPath, expectedTargetCommitSha: pinnedSha, expectedArchitecture: architecture});
  else {
    assertPinnedSource(sourceRoot, pinnedSha);
    if (!pinnedSha) throw new Error('A full pinned commit SHA is required for publication');
    const built = createReleaseArtifact({root: sourceRoot, architecture, outputDir: path.join(sourceRoot, 'dist'), targetCommitSha: pinnedSha});
    artifact = verifyReleaseArtifact({archivePath: built.archivePath, checksumPath: built.checksumPath, expectedTargetCommitSha: pinnedSha, expectedArchitecture: architecture});
    ownedArtifact = true;
  }
  if (!/^[0-9a-f]{40}$/i.test(artifact.manifest.targetCommitSha ?? '')) throw new Error('Only a release artifact with a full pinned target SHA may be published');
  validateRunnerContract(artifact.manifest.runtimeContract);
  const serviceDefinitions = [...serviceUnits].map(name => name === 'tma-analytics.service' ? userUnit(name) : name);
  const cfgId = configurationId({config: validated.analytics, serviceUnits: serviceDefinitions, runtimeContract: runtime});
  const publication = readPublication(publicationPath);
  const snapshot = configSnapshot(selected);
  const sameContent = publication?.contentHash === artifact.manifest.contentHash && publication?.configurationId === cfgId;
  return {
    artifact,
    ownedArtifact,
    manifest: artifact.manifest,
    config: validated,
    selected,
    configurationId: cfgId,
    publication,
    sameContent,
    snapshot,
    configDir: configRoot,
    currentDir: path.resolve(current),
    releasesDir: path.resolve(path.dirname(current), 'releases'),
    publicationPath,
    infrastructure,
    serviceUnits: [...serviceUnits],
    runtimeContract: runtime
  };
}

async function defaultHealthCheck(config, {fetchImpl = fetch, timeoutMs = 10000} = {}) {
  const headers = config.auth?.user ? {Authorization: `Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString('base64')}`} : {};
  const request = async route => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(config.analytics.publicOrigin + route, {headers, signal: controller.signal});
      if (!response.ok) throw new Error(`Published Analytics returned ${response.status} for ${route}`);
      await response.arrayBuffer();
    } finally { clearTimeout(timer); }
  };
  await request('/api/health');
  await request('/api/state');
}

async function backupDeployment(prepared, backupDirectory) {
  fs.mkdirSync(backupDirectory, {recursive: true, mode: 0o700});
  const databasePath = prepared.config.analytics.databasePath;
  if (fs.existsSync(databasePath)) {
    regular(databasePath);
    fs.copyFileSync(databasePath, path.join(backupDirectory, 'analytics.db'));
  }
  const configBackup = path.join(backupDirectory, 'config');
  fs.mkdirSync(configBackup, {recursive: true, mode: 0o700});
  for (const filename of [prepared.selected.analyticsConfig, prepared.selected.analyticsEnv, prepared.selected.hubSecrets].filter(Boolean)) if (fs.existsSync(filename)) fs.copyFileSync(filename, path.join(configBackup, path.basename(filename),));
}

/** Apply one already prepared artifact. Same content/config is a no-op. */
export async function applyPublication(prepared, {
  services = serviceController(),
  backup = backupDeployment,
  backupDirectory = path.join(path.dirname(prepared.currentDir), 'backups', `${prepared.manifest.releaseId}-${Date.now()}`),
  healthCheck = defaultHealthCheck,
  now = () => new Date().toISOString(),
  writePublication = true
} = {}) {
  if (prepared.sameContent) return {changed: false, restarted: false, publication: prepared.publication};
  if (!snapshotEqual(prepared.snapshot, configSnapshot(prepared.selected))) throw new Error('Configuration changed during publication preparation; retry before stopping Analytics');
  // The old-layout guard is repeated immediately before stop in case a legacy
  // file was restored while the archive was being verified.
  assertOldLayout({destination: prepared.configDir, currentDir: prepared.currentDir});
  for (const unit of prepared.serviceUnits) if (unit === 'tma-update.service') continue;
  await services.stop('tma-analytics.service');
  await backup(prepared, backupDirectory);
  const releaseDir = path.join(prepared.releasesDir, prepared.manifest.releaseId);
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(prepared.releasesDir, {recursive: true, mode: 0o755});
    copyTree(prepared.artifact.directory, releaseDir);
  }
  const next = `${prepared.currentDir}.next-${process.pid}`;
  fs.rmSync(next, {recursive: true, force: true});
  fs.symlinkSync(releaseDir, next, 'dir');
  fs.rmSync(prepared.currentDir, {recursive: true, force: true});
  fs.renameSync(next, prepared.currentDir);
  services.installUnit('tma-analytics.service', userUnit('tma-analytics.service'));
  services.daemonReload();
  await services.start('tma-analytics.service');
  await healthCheck(prepared.config);
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
  return {changed: true, restarted: true, publication: record};
}

export async function publish({lockPath = deploymentLock, ...options} = {}) {
  const {withPublicationLock} = await import('./release.mjs');
  return withPublicationLock(lockPath, async () => {
    const prepared = await preparePublication(options);
    return applyPublication(prepared, options);
  });
}

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
