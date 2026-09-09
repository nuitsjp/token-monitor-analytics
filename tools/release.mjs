import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';

/*
 * This module is deliberately independent of Analytics.  It is copied to the
 * update runner, so importing it must never open the application database or
 * load the application configuration.
 */

export const RELEASE_SCHEMA_VERSION = 1;
export const RUNTIME_CONTRACT_VERSION = 2;
export const MIN_NODE_VERSION = Object.freeze({major: 22, minor: 16, patch: 0});
export const SUPPORTED_ARCHITECTURES = Object.freeze(['amd64', 'arm64']);

// The release contains the native Node application only.  In particular,
// files under collector/ and external/ are intentionally absent even when the
// source checkout has the old Go tree or a Hub submodule populated.
const REQUIRED_FILES = Object.freeze([
  'analytics/package.json',
  'analytics/package-lock.json',
  'analytics/public/index.html',
  'analytics/public/app.js',
  'analytics/public/styles.css',
  'analytics/configs/analytics.example.json',
  'analytics/configs/demo.json',
  'analytics/configs/hub-secrets.example.json',
  'deploy/analytics.ubuntu.json',
  'deploy/analytics.env.example',
  'deploy/tma-analytics.service',
  'deploy/tma-update.service',
  'README.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md'
]);

function filesUnder(root, directory, suffix) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  const result = [];
  const visit = (current, relative) => {
    for (const name of fs.readdirSync(current).sort()) {
      const filename = path.join(current, name);
      const rel = path.join(relative, name).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) visit(filename, rel);
      else if (stat.isFile() && (!suffix || rel.endsWith(suffix))) result.push(`${directory}/${rel}`);
    }
  };
  visit(base, '');
  return result;
}

/** Return the explicit, source-controlled file allowlist for an artifact. */
export function releaseFiles(root) {
  const files = [
    ...REQUIRED_FILES,
    ...filesUnder(root, 'analytics/src', '.ts'),
    ...filesUnder(root, 'analytics/runtime', '.mjs'),
    ...filesUnder(root, 'analytics/migrations', '.sql')
  ];
  const unique = [...new Set(files)].sort();
  for (const relative of unique) {
    const filename = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(filename); } catch { throw new Error(`Release input is missing: ${relative}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input must be a regular file: ${relative}`);
  }
  return unique;
}

function updateHash(hash, value) {
  hash.update(value);
  return hash;
}

/** Stable digest of regular files. File mtimes and archive metadata are ignored. */
export function treeDigest(directory, {exclude = []} = {}) {
  const excluded = new Set(exclude);
  const hash = createHash('sha256');
  const walk = (base, relative = '') => {
    for (const name of fs.readdirSync(base).sort()) {
      const filename = path.join(base, name);
      const entry = relative + name;
      if (excluded.has(entry)) continue;
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) walk(filename, `${entry}/`);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        updateHash(hash, JSON.stringify([entry, stat.mode & 0o111, stat.size]));
        updateHash(hash, fs.readFileSync(filename));
      } else throw new Error(`Release contains a non-regular file: ${entry}`);
    }
  };
  walk(directory);
  return hash.digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : value).digest('hex');
}

/**
 * Hash only startup/service settings and release contract data.  Database
 * bytes, SQLite Hub rows, and Hub secret contents are deliberately omitted.
 */
export function configurationId({config = {}, serviceUnits = [], runtimeContract = null} = {}) {
  const viewerAuth = config.viewerAuth ?? {};
  const update = config.update ?? {};
  const settings = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    runtimeContractVersion: runtimeContract?.serviceContractVersion ?? RUNTIME_CONTRACT_VERSION,
    listen: config.listen,
    publicOrigin: config.publicOrigin,
    databasePath: config.databasePath,
    hubSecretsPath: config.hubSecretsPath,
    timeZone: config.timeZone,
    detailRetentionDays: config.detailRetentionDays,
    demo: Boolean(config.demo),
    viewerAuth: {
      mode: viewerAuth.mode,
      userEnv: viewerAuth.userEnv,
      passwordEnv: viewerAuth.passwordEnv
    },
    management: {enabled: Boolean(config.management?.enabled)},
    update: {
      enabled: Boolean(update.enabled),
      repositoryUrl: update.repositoryUrl,
      branch: update.branch,
      checkIntervalSeconds: update.checkIntervalSeconds,
      statePath: update.statePath,
      repoPath: update.repoPath,
      publicationPath: update.publicationPath
    },
    // Contract definitions are startup calculation settings.  The Hub rows
    // that the UI edits are in SQLite and are intentionally not represented.
    contracts: Array.isArray(config.contracts) ? config.contracts : [],
    serviceUnits: [...serviceUnits],
    runtimeContract
  };
  return `cfg-${sha256(stable(settings))}`;
}

function commitFromGit(root) {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
  } catch { return null; }
}

function copyReleaseFiles(root, destination, files) {
  for (const relative of files) {
    const source = path.join(root, relative);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const mode = fs.statSync(source).mode & 0o777;
    fs.chmodSync(target, mode & 0o111 ? 0o755 : 0o644);
  }
}

function archiveDirectory(payload, archive) {
  // GNU tar is used on Ubuntu.  The fallback options are understood by the
  // BSD tar shipped with development Windows environments as well.
  try {
    execFileSync('tar', ['-czf', archive, '-C', payload, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '.'], {stdio: 'ignore'});
  } catch {
    execFileSync('tar', ['-czf', archive, '-C', payload, '.'], {stdio: 'ignore'});
  }
}

/** Build a release archive and its SHA sidecar from the source allowlist. */
export function createReleaseArtifact({root, architecture = 'amd64', outputDir, targetCommitSha, targetCommitDate = null} = {}) {
  if (!root || !outputDir) throw new Error('root and outputDir are required');
  if (!SUPPORTED_ARCHITECTURES.includes(architecture)) throw new Error(`Unsupported architecture: ${architecture}`);
  const sourceRoot = path.resolve(root);
  const destination = path.resolve(outputDir);
  const files = releaseFiles(sourceRoot);
  fs.mkdirSync(destination, {recursive: true});
  const stage = fs.mkdtempSync(path.join(destination, '.tma-release-'));
  try {
    const payload = path.join(stage, 'payload');
    fs.mkdirSync(payload);
    copyReleaseFiles(sourceRoot, payload, files);
    const contentHash = treeDigest(payload);
    const commitSha = targetCommitSha ?? commitFromGit(sourceRoot);
    if (commitSha !== null && !/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error('targetCommitSha must be a full commit SHA');
    const releaseId = `rel-${sha256(stable({architecture, contentHash, targetCommitSha: commitSha}))}`;
    const manifest = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      releaseId,
      architecture,
      targetCommitSha: commitSha,
      targetCommitDate,
      contentHash,
      runtimeContract: {
        configVersion: 2,
        serviceContractVersion: RUNTIME_CONTRACT_VERSION,
        runnerVersion: 1,
        minNode: MIN_NODE_VERSION,
        appUnits: ['tma-analytics.service'],
        managedUnits: ['tma-analytics.service', 'tma-update.service']
      }
    };
    fs.writeFileSync(path.join(payload, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o644});
    const name = `tma-ubuntu-${architecture}.tar.gz`;
    const temporaryArchive = path.join(stage, name);
    archiveDirectory(payload, temporaryArchive);
    const archiveSha256 = sha256(fs.readFileSync(temporaryArchive));
    const archive = path.join(destination, name);
    const checksum = `${archiveSha256}  ${name}\n`;
    fs.rmSync(archive, {force: true});
    fs.rmSync(`${archive}.sha256`, {force: true});
    fs.copyFileSync(temporaryArchive, archive);
    fs.writeFileSync(`${archive}.sha256`, checksum, {mode: 0o644});
    return {archivePath: archive, checksumPath: `${archive}.sha256`, archiveSha256, contentHash, manifest};
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

function archiveEntries(archive) {
  const output = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'});
  return output.split(/\r?\n/).map(value => value.replace(/^\.\//, '')).filter(Boolean);
}

function rejectUnsafeArchiveEntries(entries) {
  for (const entry of entries) {
    if (path.posix.isAbsolute(entry) || entry.split('/').includes('..') || entry.includes('\\')) {
      throw new Error('Artifact contains an unsafe archive path');
    }
  }
}

/** Verify SHA, manifest, target SHA and content hash before an artifact can be applied. */
export function verifyReleaseArtifact({archivePath, checksumPath = `${archivePath}.sha256`, expectedTargetCommitSha, expectedContentHash, expectedArchitecture, extractDir} = {}) {
  if (!archivePath || !fs.statSync(archivePath).isFile()) throw new Error('Artifact archive is missing');
  const name = path.basename(archivePath);
  const actualArchiveSha256 = sha256(fs.readFileSync(archivePath));
  const checksum = fs.readFileSync(checksumPath, 'utf8');
  const match = /^(?<sha>[0-9a-f]{64})  (?<name>[^\r\n]+)\n?$/.exec(checksum);
  if (!match || match.groups.name !== name || match.groups.sha !== actualArchiveSha256) throw new Error('Artifact checksum verification failed');
  const entries = archiveEntries(archivePath);
  rejectUnsafeArchiveEntries(entries);
  const directory = extractDir ? path.resolve(extractDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'tma-artifact-'));
  fs.mkdirSync(directory, {recursive: true});
  execFileSync('tar', ['-xzf', archivePath, '-C', directory], {stdio: 'ignore'});
  const manifestPath = path.join(directory, 'release-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Artifact manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION || typeof manifest.contentHash !== 'string' || typeof manifest.releaseId !== 'string') throw new Error('Artifact manifest is invalid');
  if (expectedTargetCommitSha !== undefined && manifest.targetCommitSha !== expectedTargetCommitSha) throw new Error('Artifact target SHA does not match the requested revision');
  if (expectedContentHash !== undefined && manifest.contentHash !== expectedContentHash) throw new Error('Artifact content hash does not match the prepared revision');
  if (expectedArchitecture !== undefined && manifest.architecture !== expectedArchitecture) throw new Error('Artifact architecture does not match the requested target');
  if (manifest.contentHash !== treeDigest(directory, {exclude: ['release-manifest.json']})) throw new Error('Artifact content hash verification failed');
  return {directory, manifest, archiveSha256: actualArchiveSha256, archivePath, checksumPath, temporaryDirectory: !extractDir};
}

/** Run one publication operation under the lock shared by CLI and updater. */
export async function withPublicationLock(lockPath, callback) {
  const filename = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
  // Ubuntu provisioning and the migration tools use this same path with the
  // util-linux flock protocol. Lock descriptor 3 in a short-lived child, then
  // keep the inherited open-file description alive in this process while the
  // asynchronous callback runs. A lock file is a normal, pre-created inode;
  // its existence never means "locked" and is never unlinked.
  let handle;
  if (process.platform === 'linux') {
    handle = fs.openSync(filename, 'a+', 0o600);
    const result = spawnSync('/usr/bin/flock', ['-n', '3'], {stdio: ['ignore', 'pipe', 'pipe', handle]});
    if (result.error || result.status !== 0) {
      fs.closeSync(handle);
      throw Object.assign(new Error(result.status === 1 ? 'Another publication operation holds the deployment lock' : 'Cannot acquire deployment lock'), {code: result.status === 1 ? 'lock_conflict' : 'lock_error'});
    }
  } else {
    // Windows does not provide flock. O_EXCL is only a fallback for local
    // development and migration tooling; Ubuntu always takes the branch above.
    try { handle = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('Another publication operation holds the deployment lock'), {code: 'lock_conflict'});
      throw error;
    }
  }
  try {
    if (process.platform !== 'linux') fs.writeFileSync(handle, `${JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()})}\n`);
    return await callback();
  } finally {
    fs.closeSync(handle);
    if (process.platform !== 'linux') fs.rmSync(filename, {force: true});
  }
}

/** Reject a legacy installation before any stop or backup operation. */
export function assertOldLayout({root = null, destination = null, currentDir = null} = {}) {
  const locations = [root, destination, currentDir].filter(Boolean).map(value => path.resolve(value));
  const legacyNames = new Set(['tma-collector', 'tma-collector.service', 'collector.json', 'collector.env', 'collector.ubuntu.json']);
  const found = [];
  for (const directory of locations) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) if (legacyNames.has(name)) found.push(path.join(directory, name));
  }
  if (found.length) throw Object.assign(new Error('Legacy Collector layout requires the explicit migration procedure'), {code: 'old_layout', paths: found});
  return true;
}

export function readManifest(directory) {
  const filename = path.join(directory, 'release-manifest.json');
  if (!fs.existsSync(filename)) return null;
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
