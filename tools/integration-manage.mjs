import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {startServer} from '../analytics/runtime/server.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-native-manage-'));
let app;
try {
  const config = JSON.parse(fs.readFileSync(new URL('../analytics/configs/demo.json', import.meta.url), 'utf8'));
  config.databasePath = path.join(temp, 'analytics.db');
  config.hubSecretsPath = path.join(temp, 'hub-secrets.json');
  fs.writeFileSync(config.hubSecretsPath, '{"schemaVersion":1,"secrets":{}}\n', {mode: 0o600});
  config.listen.host = '127.0.0.1'; config.listen.port = await freePort(); config.publicOrigin = `http://127.0.0.1:${config.listen.port}`; config.management = {enabled: true};
  app = await startServer(config, {logger: {info() {}, error: console.error}});
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(origin + '/api/manage/hubs', {headers: {Host: new URL(origin).host, Origin: origin}});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.hubs));
  console.log('PASS: one-process Hub management API uses the Analytics SQLite store');
} finally {
  if (app) await app.close();
  fs.rmSync(temp, {recursive: true, force: true});
}
