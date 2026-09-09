import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReleaseArtifact,gitRevision,assertPinnedSource} from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [architecture = 'amd64', ...extra] = process.argv.slice(2);
const release = extra.length === 1 && extra[0] === '--release';
if (!['amd64', 'arm64'].includes(architecture) || (extra.length > 0 && !release)) throw new Error('Usage: package-ubuntu.mjs [amd64|arm64] [--release]');

let checks = null;
const targetCommitSha = gitRevision(root);
if (release) {
  assertPinnedSource(root, targetCommitSha);
  const {runReleaseVerification} = await import('./release.mjs');
  checks = runReleaseVerification(root);
}

const result = createReleaseArtifact({root, architecture, outputDir: path.join(root, 'dist'), targetCommitSha, certified: Boolean(checks), verification: checks ? {level: 'release', checks} : undefined});
console.log(`Created ${path.relative(root, result.archivePath)} and ${path.relative(root, result.checksumPath)}`);
console.log(`Content hash: ${result.contentHash}`);
