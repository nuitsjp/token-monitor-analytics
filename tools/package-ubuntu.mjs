import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReleaseArtifact} from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [architecture = 'amd64', ...extra] = process.argv.slice(2);
if (!['amd64', 'arm64'].includes(architecture) || extra.length) throw new Error('Usage: package-ubuntu.mjs [amd64|arm64]');

const result = createReleaseArtifact({root, architecture, outputDir: path.join(root, 'dist')});
console.log(`Created ${path.relative(root, result.archivePath)} and ${path.relative(root, result.checksumPath)}`);
console.log(`Content hash: ${result.contentHash}`);

