import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyReleaseArtifact} from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [architecture = 'amd64', ...extra] = process.argv.slice(2);
assert.ok(['amd64', 'arm64'].includes(architecture) && extra.length === 0, 'Expected amd64 or arm64');
const name = `tma-ubuntu-${architecture}.tar.gz`;
const archive = path.join(root, 'dist', name);
const checked = verifyReleaseArtifact({archivePath: archive, expectedArchitecture: architecture});
const temp = checked.directory;
let app;
try {
  const entries = fs.readdirSync(temp, {recursive: true}).map(String);
  assert.ok(!entries.some(entry => /(^|[/\\])(node_modules|data|outbox|\.git|\.wrangler|external|collector)([/\\]|$)|config\.local\.json$|\.env$|\.(db|sqlite)(-|$)/.test(entry)), 'Private or legacy files in package');
  assert.ok(!entries.some(entry => /(^|[/\\])(?:go\.mod|go\.sum|tma-collector)([/\\]|$)/.test(entry)), 'Go/Collector artifact in package');
  for (const required of ['analytics/runtime/server.mjs', 'analytics/runtime/config.mjs', 'analytics/src/history.ts', 'analytics/migrations/0003_usage_history.sql', 'release-manifest.json']) assert.ok(fs.existsSync(path.join(temp, required)), `Missing ${required}`);
  assert.equal(fs.existsSync(path.join(temp, 'analytics/src/index.ts')), false, 'Legacy Cloudflare file in native package');
  assert.equal(fs.existsSync(path.join(temp, 'analytics/wrangler.jsonc')), false, 'Cloudflare runtime must not be packaged');

  const configModule = await import(pathToFileURL(path.join(temp, 'analytics/runtime/config.mjs')).href);
  const serverModule = await import(pathToFileURL(path.join(temp, 'analytics/runtime/server.mjs')).href);
  const configFile = path.join(temp, 'analytics/configs/demo.json');
  const config = configModule.loadConfig(configFile);
  config.databasePath = path.join(temp, 'test.db');
  config.hubSecretsPath = path.join(temp, 'hub-secrets.json');
  fs.writeFileSync(config.hubSecretsPath, '{"schemaVersion":1,"secrets":{}}\n', {mode: 0o600});
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  config.listen.host = '127.0.0.1';
  config.listen.port = port;
  config.publicOrigin = `http://127.0.0.1:${port}`;
  app = await serverModule.startServer(config, {env: process.env, logger: {info() {}, error() {}}});
  for (const route of ['/', '/app.js', '/styles.css', '/api/health', '/api/state']) {
    const response = await fetch(config.publicOrigin + route);
    assert.equal(response.status, 200, route);
    if (route === '/api/health' || route === '/api/state') {
      const body = await response.json();
      assert.equal(body.release?.releaseId, checked.manifest.releaseId, `${route} release id`);
      assert.equal(body.release?.targetCommitSha, checked.manifest.targetCommitSha, `${route} target SHA`);
      assert.equal(body.release?.contentHash, checked.manifest.contentHash, `${route} content hash`);
    } else await response.arrayBuffer();
  }
  if (fs.existsSync(path.join(temp, 'analytics/public/usage-history.mjs'))) {
    const response = await fetch(config.publicOrigin + '/usage-history.mjs');
    assert.equal(response.status, 200, '/usage-history.mjs');
    assert.match(response.headers.get('content-type') ?? '', /javascript|ecmascript/i, 'history module MIME type');
    assert.ok((await response.text()).includes('historyFetchErrorText'), 'history module content');
  }
  assert.ok(fs.existsSync(config.databasePath), 'Analytics must open a SQLite database from the extracted package');
  console.log(`PASS: ${architecture} checksum, manifest/content hash, package contents, extracted Analytics HTTP/SQLite`);
} finally {
  if (app) await app.close();
  if (checked.temporaryDirectory) fs.rmSync(temp, {recursive: true, force: true});
}
