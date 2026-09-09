/*
 * Prepare the pinned legacy source bundle used by the explicit migration
 * acceptance run.  This command is intentionally separate from release and
 * runtime paths: a normal archive has no old Git objects and never executes
 * this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const LEGACY_COMMIT_SHA = 'cae687c4947990e9da6db3193ea8afe26b4b5246';

function sha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return path.resolve(value);
}

function ensureEmptyDirectory(filename) {
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(filename).length) {
      throw new Error('Source output directory must be an empty regular directory');
    }
  } else {
    fs.mkdirSync(filename, {recursive: true, mode: 0o700});
  }
}

export function prepareLegacySource({repository, output, archive, manifest, commitSha = LEGACY_COMMIT_SHA} = {}) {
  const repositoryRoot = absolute(repository, 'Repository');
  const outputRoot = absolute(output, 'Output');
  const archivePath = absolute(archive, 'Archive');
  const manifestPath = absolute(manifest, 'Manifest');
  if (!/^[0-9a-f]{40}$/i.test(commitSha) || commitSha.toLowerCase() !== LEGACY_COMMIT_SHA) {
    throw new Error(`Only the pinned legacy commit ${LEGACY_COMMIT_SHA} is accepted`);
  }
  ensureEmptyDirectory(outputRoot);
  fs.mkdirSync(path.dirname(archivePath), {recursive: true, mode: 0o700});
  fs.rmSync(archivePath, {force: true});
  try {
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {cwd: repositoryRoot, stdio: 'ignore'});
  } catch {
    throw new Error(`Pinned legacy commit ${commitSha} is unavailable in the repository`);
  }
  execFileSync('git', ['archive', '--format=tar', commitSha, '--output', archivePath], {cwd: repositoryRoot, stdio: 'ignore'});
  execFileSync('tar', ['-xf', archivePath, '-C', outputRoot], {stdio: 'ignore'});
  const result = {
    schemaVersion: 1,
    commitSha: commitSha.toLowerCase(),
    repository: repositoryRoot,
    sourceRoot: outputRoot,
    archivePath,
    archiveSha256: sha256(archivePath),
    preparedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(manifestPath), {recursive: true, mode: 0o700});
  fs.writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
  return result;
}

function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({args: argv, options: {
    repository: {type: 'string'},
    output: {type: 'string'},
    archive: {type: 'string'},
    manifest: {type: 'string'},
    sha: {type: 'string', default: LEGACY_COMMIT_SHA},
  }, strict: true});
  const result = prepareLegacySource({repository: values.repository, output: values.output, archive: values.archive, manifest: values.manifest, commitSha: values.sha});
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error?.message ?? 'Could not prepare the pinned legacy source'); process.exitCode = 1; }
}
