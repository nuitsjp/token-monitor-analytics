import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validateHubsFile, validateHubSecretsFile, validateHubUrl} from '../src/hubs.ts';
import {readHubsConfig, writeAtomicFile, saveHubsTransaction} from '../runtime/hubs.mjs';
import {loadConfig} from '../runtime/config.mjs';

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-hubs-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('validateHubUrl enforces HTTPS or loopback HTTP without paths or queries', () => {
  assert.equal(validateHubUrl('https://hub.example.com'), 'https://hub.example.com');
  assert.equal(validateHubUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(validateHubUrl('http://localhost:8787'), 'http://localhost:8787');

  assert.throws(() => validateHubUrl('http://hub.example.com'), /HTTP Hub URL is only permitted for loopback development/);
  assert.throws(() => validateHubUrl('https://hub.example.com/api'), /Hub URL must not contain path segments/);
  assert.throws(() => validateHubUrl('https://hub.example.com?query=1'), /Hub URL must not contain query parameters/);
  assert.throws(() => validateHubUrl('https://hub.example.com#hash'), /Hub URL must not contain query parameters or fragments/);
  assert.throws(() => validateHubUrl('https://user:pass@hub.example.com'), /Hub URL must not contain authentication credentials/);
  assert.throws(() => validateHubUrl('not-a-url'), /Hub URL is not a valid URL/);
});

test('validateHubsFile and validateHubSecretsFile validate schema and limits', () => {
  const validHubs = {
    schemaVersion: 1,
    revision: 0,
    secretsPath: './hub-secrets.json',
    hubs: [
      {id: 'hub-1', label: 'Hub 1', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-1'}
    ]
  };
  assert.doesNotThrow(() => validateHubsFile(validHubs));

  assert.throws(() => validateHubsFile({...validHubs, schemaVersion: 2}), /schemaVersion must be 1/);
  assert.throws(() => validateHubsFile({...validHubs, revision: -1}), /revision must be a non-negative integer/);
  assert.throws(() => validateHubsFile({...validHubs, secretsPath: '/etc/secrets.json'}), /secretsPath must be a relative path/);
  assert.throws(() => validateHubsFile({...validHubs, unknownField: true}), /Unknown field/);

  // Duplicate ID
  assert.throws(() => validateHubsFile({
    ...validHubs,
    hubs: [
      {id: 'hub-1', label: 'Hub 1', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-1'},
      {id: 'hub-1', label: 'Hub 2', url: 'https://hub2.example.com', status: 'active', secretRef: 'sec-2'}
    ]
  }), /Duplicate hub ID/);

  // Duplicate URL
  assert.throws(() => validateHubsFile({
    ...validHubs,
    hubs: [
      {id: 'hub-1', label: 'Hub 1', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-1'},
      {id: 'hub-2', label: 'Hub 2', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-2'}
    ]
  }), /Duplicate hub URL/);

  // Exceeding 8 active hubs
  const nineHubs = Array.from({length: 9}, (_, i) => ({
    id: `hub-${i}`,
    label: `Hub ${i}`,
    url: `https://hub${i}.example.com`,
    status: 'active',
    secretRef: `sec-${i}`
  }));
  assert.throws(() => validateHubsFile({...validHubs, hubs: nineHubs}), /Cannot configure more than 8 non-archived hubs/);

  // Archived hubs do not count towards the 8 limit
  const eightPlusArchived = [
    ...nineHubs.slice(0, 8),
    {id: 'hub-archived', label: 'Archived', url: 'https://archived.example.com', status: 'archived', secretRef: 'sec-arch'}
  ];
  assert.doesNotThrow(() => validateHubsFile({...validHubs, hubs: eightPlusArchived}));

  // Secrets validation
  const validSecrets = {
    schemaVersion: 1,
    secrets: {
      'sec-1': 'super-secret-token-12345'
    }
  };
  assert.doesNotThrow(() => validateHubSecretsFile(validSecrets));
  assert.throws(() => validateHubSecretsFile({...validSecrets, secrets: {'sec-1': 'invalid\nsecret'}}), /without newlines/);
  assert.throws(() => validateHubSecretsFile({...validSecrets, secrets: {'sec-1': ''}}), /must be non-empty/);
});

test('readHubsConfig and saveHubsTransaction support atomic updates and conflict detection', async (t) => {
  const dir = createTempDir(t);
  const hubsPath = path.join(dir, 'hubs.json');
  const secretsPath = path.join(dir, 'hub-secrets.json');

  writeAtomicFile(secretsPath, JSON.stringify({
    schemaVersion: 1,
    secrets: {'sec-init': 'initial-secret-12345'}
  }));
  writeAtomicFile(hubsPath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    secretsPath: './hub-secrets.json',
    hubs: [
      {id: 'hub-init', label: 'Initial Hub', url: 'https://init.example.com', status: 'active', secretRef: 'sec-init'}
    ]
  }));

  const initial = readHubsConfig(hubsPath);
  assert.equal(initial.hubsFile.revision, 1);
  assert.equal(initial.hubsFile.hubs.length, 1);
  assert.equal(initial.secretsFile.secrets['sec-init'], 'initial-secret-12345');

  // Conflict detection
  await assert.rejects(
    saveHubsTransaction(hubsPath, 0, () => []),
    (err) => err.status === 409
  );

  // Successful transaction with new secret and new hub
  const updated = await saveHubsTransaction(hubsPath, 1, ({hubs, createSecretRef}) => {
    const newRef = createSecretRef('new-secret-98765');
    return [
      ...hubs,
      {id: 'hub-2', label: 'Hub Two', url: 'https://two.example.com', status: 'active', secretRef: newRef}
    ];
  });

  assert.equal(updated.hubsFile.revision, 2);
  assert.equal(updated.hubsFile.hubs.length, 2);

  // Read back to verify persistence
  const persisted = readHubsConfig(hubsPath);
  assert.equal(persisted.hubsFile.revision, 2);
  assert.equal(persisted.hubsFile.hubs[1].id, 'hub-2');
  assert.equal(persisted.secretsFile.secrets['sec-init'], 'initial-secret-12345');
  assert.equal(persisted.secretsFile.secrets[persisted.hubsFile.hubs[1].secretRef], 'new-secret-98765');
});

test('loadConfig integrates hubsPath and management mode correctly', (t) => {
  const dir = createTempDir(t);
  const hubsPath = path.join(dir, 'hubs.json');
  const secretsPath = path.join(dir, 'hub-secrets.json');

  writeAtomicFile(secretsPath, JSON.stringify({
    schemaVersion: 1,
    secrets: {}
  }));
  // Empty hubs is valid for management mode
  writeAtomicFile(hubsPath, JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    secretsPath: './hub-secrets.json',
    hubs: []
  }));

  const baseConfig = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  delete baseConfig.hubs;
  baseConfig.demo = false;
  baseConfig.hubsPath = './hubs.json';
  baseConfig.management = {enabled: true};
  baseConfig.contracts = [];
  baseConfig.databasePath = path.join(dir, 'test.db');

  const configFile = path.join(dir, 'analytics.json');
  fs.writeFileSync(configFile, JSON.stringify(baseConfig));

  const loaded = loadConfig(configFile);
  assert.equal(loaded.management.enabled, true);
  assert.equal(loaded.hubs.length, 0);
  assert.ok(loaded.hubsPath.endsWith('hubs.json'));

  // Setting both hubs and hubsPath should throw
  baseConfig.hubs = [{id: 'h1', label: 'Hub 1'}];
  fs.writeFileSync(configFile, JSON.stringify(baseConfig));
  assert.throws(() => loadConfig(configFile), /Cannot specify both hubs and hubsPath/);

  // Enabling management without hubsPath should throw
  delete baseConfig.hubsPath;
  fs.writeFileSync(configFile, JSON.stringify(baseConfig));
  assert.throws(() => loadConfig(configFile), /Management mode requires hubsPath/);
});

test('management HTTP API handles CRUD, conflict detection, contracts and Collector status', async (t) => {
  const dir = createTempDir(t);
  const hubsPath = path.join(dir, 'hubs.json');
  const secretsPath = path.join(dir, 'hub-secrets.json');

  writeAtomicFile(secretsPath, JSON.stringify({
    schemaVersion: 1,
    secrets: {'sec-1': 'hub-one-secret'}
  }));
  writeAtomicFile(hubsPath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    secretsPath: './hub-secrets.json',
    hubs: [
      {id: 'hub-1', label: 'Hub One', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-1'}
    ]
  }));

  const baseConfig = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  delete baseConfig.hubs;
  baseConfig.demo = false;
  baseConfig.hubsPath = './hubs.json';
  baseConfig.management = {enabled: true};
  baseConfig.listen = {host: '127.0.0.1', port: 8787};
  baseConfig.contracts = [
    {
      id: 'c1', label: 'Contract 1', hubId: 'hub-1', provider: 'claude', accountKey: 'acc',
      clientIds: ['cli'], deviceIds: ['dev'], windowKind: 'weekly', windowHours: 168,
      monthlyFeeUsd: 100, attributionConfirmed: true, minDeltaPercent: 5, maxSourceSkewSeconds: 60, maxGapSeconds: 300
    }
  ];
  baseConfig.databasePath = path.join(dir, 'test.db');

  const configFile = path.join(dir, 'analytics.json');
  fs.writeFileSync(configFile, JSON.stringify(baseConfig));

  const {startServer} = await import('../runtime/server.mjs');
  const env = {TMA_INGEST_TOKEN: 'test-ingest-token-12345678901234567890'};
  const conf = loadConfig(configFile);
  conf.listen.port = 0;
  const app = await startServer(conf, {env, heartbeatMs: 50, logger: {info(){}, error(){}}});
  const port = app.server.address().port;
  conf.publicOrigin = `http://127.0.0.1:${port}`;
  try {
    const origin = conf.publicOrigin;

  // 1. GET /api/manage/hubs
  const getRes = await fetch(`${origin}/api/manage/hubs`);
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.revision, 1);
  assert.equal(getData.hubs.length, 1);
  assert.equal(getData.hubs[0].id, 'hub-1');
  assert.equal(getData.hubs[0].hasSecret, true);
  assert.equal(getData.collector.status, 'unknown');

  // 2. Collector reports status via POST /api/collector/status
  const reportRes = await fetch(`${origin}/api/collector/status`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.TMA_INGEST_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      appliedRevision: 1,
      hubs: [{id: 'hub-1', status: 'connected', updatedAt: new Date().toISOString()}]
    })
  });
  assert.equal(reportRes.status, 200);

  // Status should now be active
  const checkReport = await (await fetch(`${origin}/api/manage/hubs`)).json();
  assert.equal(checkReport.collector.status, 'active');
  assert.equal(checkReport.collector.appliedRevision, 1);
  assert.equal(checkReport.collector.hubs['hub-1'].status, 'connected');

  // Management writes require Origin and independent Hub credentials.
  const missingOrigin = await fetch(`${origin}/api/manage/hubs/hub-1`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({expectedRevision: 1, label: 'Must not change'})
  });
  assert.equal(missingOrigin.status, 403);
  for (const secret of [env.TMA_INGEST_TOKEN, 'demo-hub-secret', 'REPLACE_SECRET']) {
    const reused = await fetch(`${origin}/api/manage/hubs/hub-1`, {
      method: 'PUT', headers: {'Content-Type': 'application/json', Origin: origin},
      body: JSON.stringify({expectedRevision: 1, secret})
    });
    assert.equal(reused.status, 400);
  }
  assert.equal(readHubsConfig(hubsPath).hubsFile.revision, 1);

  // 3. POST /api/manage/hubs - Add new hub
  const addRes = await fetch(`${origin}/api/manage/hubs`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({
      expectedRevision: 1,
      id: 'hub-2',
      label: 'Hub Two',
      url: 'https://hub2.example.com',
      secret: 'hub-two-secret-value'
    })
  });
  assert.equal(addRes.status, 200);
  const addData = await addRes.json();
  assert.equal(addData.revision, 2);

  // 4. Try deleting hub-1 while referenced by contract c1 -> rejected with 400
  const delRefRes = await fetch(`${origin}/api/manage/hubs/hub-1`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedRevision: 2})
  });
  assert.equal(delRefRes.status, 400);
  const delRefData = await delRefRes.json();
  assert.equal(delRefData.error, 'hub_referenced_by_contract');

  // 5. Update hub-2 status to disabled via PUT /api/manage/hubs/hub-2
  const putRes = await fetch(`${origin}/api/manage/hubs/hub-2`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({
      expectedRevision: 2,
      status: 'disabled'
    })
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.revision, 3);

  // 6. Delete hub-2 (not referenced by contracts) -> archived
  const delRes = await fetch(`${origin}/api/manage/hubs/hub-2`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({expectedRevision: 3})
  });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.revision, 4);

  // Active list should only contain hub-1 now
  const listAfterDel = await (await fetch(`${origin}/api/manage/hubs`)).json();
  assert.equal(listAfterDel.hubs.length, 1);
  assert.equal(listAfterDel.hubs[0].id, 'hub-1');
  } catch (err) {
    console.error('Test error caught:', err);
    throw err;
  } finally {
    await app.close();
  }
});



test('Node and Collector share Japanese and emoji label boundaries', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('../../test-fixtures/hub-labels.json', import.meta.url), 'utf8'));
  for (const c of cases) {
    const validate = () => validateHubsFile({schemaVersion: 1, revision: 1, secretsPath: 'secrets.json', hubs: [
      {id: 'h1', label: c.label, url: 'https://example.com', status: 'active', secretRef: 's1'}
    ]});
    if (c.valid) assert.doesNotThrow(validate, c.name);
    else assert.throws(validate, /label/, c.name);
  }
});

test('oversized serialized configuration leaves both files unchanged', async t => {
  const dir = createTempDir(t), hubsPath = path.join(dir, 'hubs.json'), secretsPath = path.join(dir, 'secrets.json');
  writeAtomicFile(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {s1: 'test-secret'}}));
  writeAtomicFile(hubsPath, JSON.stringify({schemaVersion: 1, revision: 1, secretsPath: 'secrets.json', hubs: [
    {id: 'h1', label: 'Hub', url: 'https://example.com', status: 'active', secretRef: 's1'}
  ]}));
  const beforeHubs = fs.readFileSync(hubsPath), beforeSecrets = fs.readFileSync(secretsPath);
  for (const largeSecret of [true, false]) {
    await assert.rejects(saveHubsTransaction(hubsPath, 1, ({hubs, createSecretRef}) => {
      const secretRef = createSecretRef(largeSecret ? 'あ'.repeat(90000) : 'new-secret');
      return [{...hubs[0], secretRef, url: largeSecret ? hubs[0].url : 'https://' + 'x'.repeat(270000) + '.example.com'}];
    }), error => error.status === 413);
    assert.deepEqual(fs.readFileSync(hubsPath), beforeHubs);
    assert.deepEqual(fs.readFileSync(secretsPath), beforeSecrets);
    assert.equal(readHubsConfig(hubsPath).hubsFile.revision, 1);
  }
});

test('management responses hide malformed secret contents and filesystem paths', async t => {
  const dir = createTempDir(t), hubsPath = path.join(dir, 'hubs.json'), secretsPath = path.join(dir, 'secrets.json');
  writeAtomicFile(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {s1: 'test-secret'}}));
  writeAtomicFile(hubsPath, JSON.stringify({schemaVersion: 1, revision: 1, secretsPath: 'secrets.json', hubs: [
    {id: 'h1', label: 'Hub', url: 'https://example.com', status: 'active', secretRef: 's1'}
  ]}));
  const config = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(config, {hubsPath, management: {enabled: true}, contracts: [], databasePath: path.join(dir, 'test.db')});
  config.listen.port = 0;
  const {startServer} = await import('../runtime/server.mjs');
  const app = await startServer(config, {env: {TMA_INGEST_TOKEN: 'demo-ingest-token-not-for-production'}, logger: {info(){}, error(){}}});
  config.publicOrigin = `http://127.0.0.1:${app.server.address().port}`;
  try {
   for (const malformed of [true, false]) {
    if (malformed) fs.writeFileSync(secretsPath, '{"schemaVersion":1,"secrets":{"s1":SENSITIVE_TOKEN}}');
    else fs.unlinkSync(secretsPath);
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['POST', '', {expectedRevision: 1, id: 'h2', label: 'Hub 2', url: 'https://two.example.com', secret: 'new-secret'}],
      ['PUT', '/h1', {expectedRevision: 1, label: 'New label'}],
      ['DELETE', '/h1', {expectedRevision: 1}]
    ]) {
      const response = await fetch(config.publicOrigin + '/api/manage/hubs' + suffix, {
        method, headers: {'Content-Type': 'application/json', Origin: config.publicOrigin}, body: body && JSON.stringify(body)
      });
      assert.ok(response.status >= 400);
      const text = await response.text();
      assert.doesNotMatch(text, /SENSITIVE|secrets.json|schemaVersion/);
      assert.ok(!text.includes(dir));
      assert.equal(JSON.parse(text).message, undefined);
    }
   }
  } finally {
   await app.close();
  }
});
