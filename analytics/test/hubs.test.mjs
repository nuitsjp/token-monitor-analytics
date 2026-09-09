import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateHubsFile, validateHubSecretsFile, validateHubUrl} from '../src/hubs.ts';
import {
  readHubsConfig, writeAtomicFile, saveHubsTransaction, readHubSecretStore,
  readHubSecret, writeHubSecret, listHubRecords, insertHub, updateHubRecord,
  archiveHubRecord, recordContractSnapshots,
} from '../runtime/hubs.mjs';
import {loadConfig} from '../runtime/config.mjs';
import {openDatabase,transaction} from '../runtime/sqlite.mjs';
import {startServer} from '../runtime/server.mjs';
import {contract as fixtureContract} from './adapter.mjs';

if (process.platform === 'win32') process.env.TMA_WINDOWS_ACL_DEBUG = '1';

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tma-hubs-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function writeConfig(dir, raw) {
  const file = path.join(dir, 'analytics.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
}

function assertPrivateSecretAcl(filename) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    return;
  }
  const result = spawnSync('icacls', [filename], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || 'icacls failed');
  const acl = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(acl, /(?:Everyone|Authenticated Users|(?:BUILTIN\\)?Users)\s*:/i, `secret ACL is broader than the owner/system administrators: ${acl}`);

  // Resolve the access rules as SIDs rather than parsing localized icacls or
  // SDDL aliases. The file owner is not necessarily the creating identity
  // (Windows may canonicalize it to BUILTIN\\Administrators), so compare the
  // creating SID reported by WindowsIdentity with the exact ACE trustees.
  const aclScript = '$ErrorActionPreference="Stop"; $securityModule=Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"; Import-Module -Name $securityModule -Force; $acl=Get-Acl -LiteralPath $env:TMA_ACL_PATH; $creator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Write-Output "CREATOR=$creator"; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { Write-Output ((@($rule.AccessControlType,$rule.FileSystemRights.ToString(),$rule.IsInherited,$rule.InheritanceFlags.ToString(),$rule.PropagationFlags.ToString(),$rule.IdentityReference.Value) -join "`t")) }';
  const aclEncoded = Buffer.from(aclScript, 'utf16le').toString('base64');
  const aclResult = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', aclEncoded
  ], {encoding: 'utf8', env: {...process.env, TMA_ACL_PATH: filename}});
  assert.equal(aclResult.status, 0, aclResult.stderr || 'PowerShell ACL inspection failed');
  const lines = aclResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  const creatorLine = lines.shift();
  assert.match(creatorLine ?? '', /^CREATOR=S-1-\d+(?:-\d+)+$/);
  const rules = lines.map(line => {
    const [type, rights, inherited, inheritance, propagation, sid] = line.split('\t');
    return {type, rights, inherited, inheritance, propagation, sid};
  });
  assert.equal(rules.length, 3, `unexpected secret ACL entries: ${aclResult.stdout}`);
  assert.ok(rules.every(rule => rule.type === 'Allow' && rule.rights === 'FullControl' && rule.inherited === 'False' && rule.inheritance === 'None' && rule.propagation === 'None' && /^S-1-\d+(?:-\d+)+$/.test(rule.sid)), `secret ACL has unexpected rights or inheritance: ${aclResult.stdout}`);
  assert.deepEqual(new Set(rules.map(rule => rule.sid)), new Set([creatorLine.slice('CREATOR='.length), 'S-1-5-18', 'S-1-5-32-544']), `secret ACL principals are not creator/SYSTEM/Administrators: ${aclResult.stdout}`);
}

function grantBroadParentAcl(directory) {
  if (process.platform !== 'win32') return;
  const result = spawnSync('icacls', [directory, '/grant', '*S-1-1-0:(OI)(CI)(F)'], {encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stderr || ''}${result.stdout || ''}`);
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

test('validateHubsFile and validateHubSecretsFile validate the migration-only file schemas', () => {
  const validHubs = {
    schemaVersion: 1,
    revision: 0,
    secretsPath: './hub-secrets.json',
    hubs: [{id: 'hub-1', label: 'Hub 1', url: 'https://hub1.example.com', status: 'active', secretRef: 'sec-1'}],
  };
  assert.doesNotThrow(() => validateHubsFile(validHubs));
  assert.throws(() => validateHubsFile({...validHubs, schemaVersion: 2}), /schemaVersion must be 1/);
  assert.throws(() => validateHubsFile({...validHubs, revision: -1}), /revision must be a non-negative integer/);
  assert.throws(() => validateHubsFile({...validHubs, secretsPath: '/etc/secrets.json'}), /secretsPath must be a relative path/);
  assert.throws(() => validateHubsFile({...validHubs, unknownField: true}), /Unknown field/);
  assert.throws(() => validateHubsFile({...validHubs, hubs: [validHubs.hubs[0], {...validHubs.hubs[0], url: 'https://hub2.example.com'}]}), /Duplicate hub ID/);
  assert.throws(() => validateHubsFile({...validHubs, hubs: [validHubs.hubs[0], {...validHubs.hubs[0], id: 'hub-2', secretRef: 'sec-2'}]}), /Duplicate hub URL/);
  const nineHubs = Array.from({length: 9}, (_, i) => ({id: `hub-${i}`, label: `Hub ${i}`, url: `https://hub${i}.example.com`, status: 'active', secretRef: `sec-${i}`}));
  assert.throws(() => validateHubsFile({...validHubs, hubs: nineHubs}), /Cannot configure more than 8 non-archived hubs/);
  assert.doesNotThrow(() => validateHubsFile({...validHubs, hubs: [...nineHubs.slice(0, 8), {id: 'archived', label: 'Archived', url: 'https://archived.example.com', status: 'archived', secretRef: 'sec-arch'}]}));
  const validSecrets = {schemaVersion: 1, secrets: {'sec-1': 'super-secret-token-12345'}};
  assert.doesNotThrow(() => validateHubSecretsFile(validSecrets));
  assert.throws(() => validateHubSecretsFile({...validSecrets, secrets: {'sec-1': 'invalid\nsecret'}}), /without newlines/);
  assert.throws(() => validateHubSecretsFile({...validSecrets, secrets: {'sec-1': ''}}), /must be non-empty/);
});

test('migration-only file helpers retain atomic updates and conflict detection', async t => {
  const dir = createTempDir(t);
  const hubsPath = path.join(dir, 'hubs.json');
  const secretsPath = path.join(dir, 'hub-secrets.json');
  writeAtomicFile(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {'sec-init': 'initial-secret-12345'}}));
  writeAtomicFile(hubsPath, JSON.stringify({schemaVersion: 1, revision: 1, secretsPath: './hub-secrets.json', hubs: [
    {id: 'hub-init', label: 'Initial Hub', url: 'https://init.example.com', status: 'active', secretRef: 'sec-init'},
  ]}));
  const initial = readHubsConfig(hubsPath);
  assert.equal(initial.hubsFile.revision, 1);
  assert.equal(initial.secretsFile.secrets['sec-init'], 'initial-secret-12345');
  await assert.rejects(saveHubsTransaction(hubsPath, 0, () => []), error => error.status === 409);
  const updated = await saveHubsTransaction(hubsPath, 1, ({hubs, createSecretRef}) => [
    ...hubs,
    {id: 'hub-2', label: 'Hub Two', url: 'https://two.example.com', status: 'active', secretRef: createSecretRef('new-secret-98765')},
  ]);
  assert.equal(updated.hubsFile.revision, 2);
  const persisted = readHubsConfig(hubsPath);
  assert.equal(persisted.hubsFile.hubs.length, 2);
  assert.equal(persisted.secretsFile.secrets[persisted.hubsFile.hubs[1].secretRef], 'new-secret-98765');
});

test('secrets use an opaque reference and an atomically replaced protected file', t => {
  const dir = createTempDir(t);
  const filename = path.join(dir, 'nested', 'hub-secrets.json');
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(filename), {recursive: true});
    // Force an inherited broad ACE on the parent. The private writer must
    // remove it from its empty temp file before writing any secret bytes.
    grantBroadParentAcl(path.dirname(filename));
  }
  const firstRef = writeHubSecret(filename, 'first-secret');
  assert.match(firstRef, /^sec-[0-9a-f]{32}$/);
  assert.equal(readHubSecret(filename, firstRef), 'first-secret');
  assertPrivateSecretAcl(filename);
  const secondRef = writeHubSecret(filename, 'second-secret');
  assert.notEqual(firstRef, secondRef);
  assert.equal(readHubSecret(filename, firstRef), 'first-secret');
  assert.equal(readHubSecret(filename, secondRef), 'second-secret');
  const malformed = path.join(dir, 'malformed.json');
  fs.writeFileSync(malformed, '{not-json');
  assert.throws(() => readHubSecretStore(malformed), error => error.code === 'secret_store_invalid');
});

test('SQLite Hub rows use CAS versions, preserve archives, and snapshot descriptions', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const row = transaction(db,() => insertHub(db, {id: 'hub-1', label: 'Hub', url: 'https://hub.example.com', status: 'active', secretRef: 'sec-1'}));
  assert.equal(row.version, 1);
  assert.equal(row.lastObservationAt, null);
  const changed = transaction(db,() => updateHubRecord(db, 'hub-1', 1, {label: 'Renamed'}));
  assert.equal(changed.version, 2);
  assert.equal(changed.label, 'Renamed');
  assert.throws(() => transaction(db,() => updateHubRecord(db, 'hub-1', 1, {label: 'stale'})), error => error.code === 'version_conflict' && error.currentVersion === 2);
  const archived = transaction(db,() => archiveHubRecord(db, 'hub-1', 2));
  assert.equal(archived.status, 'archived');
  assert.equal(listHubRecords(db, {includeArchived: false}).length, 0);
  transaction(db,() => recordContractSnapshots(db, [{...fixtureContract, id: 'contract-1', hubId: 'hub-1'}]));
  assert.equal(db.prepare('SELECT count(*) n FROM hub_snapshots').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) n FROM contract_snapshots').get().n, 1);
});

test('v2 config has one Hub source of truth and rejects the old layout', t => {
  const dir = createTempDir(t);
  const base = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(base, {demo: false, databasePath: './analytics.db', hubSecretsPath: './hub-secrets.json', contracts: []});
  const file = writeConfig(dir, base);
  const loaded = loadConfig(file);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.databasePath, path.join(dir, 'analytics.db'));
  assert.equal(loaded.hubSecretsPath, path.join(dir, 'hub-secrets.json'));
  fs.writeFileSync(file, JSON.stringify({...base, version: 1}));
  assert.throws(() => loadConfig(file), /version=2/);
  fs.writeFileSync(file, JSON.stringify({...base, hubs: []}));
  assert.throws(() => loadConfig(file), /unknown configuration field/);
  fs.writeFileSync(file, JSON.stringify({...base, hubsPath: './hubs.json'}));
  assert.throws(() => loadConfig(file), /unknown configuration field/);
});

test('management API performs SQLite CRUD, CAS conflicts, and archive constraints', async t => {
  const dir = createTempDir(t);
  const secretsPath = path.join(dir, 'hub-secrets.json');
  const databasePath = path.join(dir, 'analytics.db');
  writeAtomicFile(secretsPath, JSON.stringify({schemaVersion: 1, secrets: {initial: 'hub-one-secret'}}));
  const db = openDatabase(databasePath);
  transaction(db,() => insertHub(db, {id: 'hub-1', label: 'Hub One', url: 'http://127.0.0.1:1', status: 'active', secretRef: 'initial'}));
  db.close();
  const c1 = {...fixtureContract, id: 'contract-1', hubId: 'hub-1'};
  const raw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(raw, {demo: false, databasePath, hubSecretsPath: secretsPath, management: {enabled: true}, contracts: [c1], listen: {host: '127.0.0.1', port: 8787}});
  const config = loadConfig(writeConfig(dir, raw));
  config.listen.port = 0;
  const app = await startServer(config, {logger: {info() {}, error() {}}, collectionIdleMs: 1000});
  config.listen.port = app.server.address().port;
  config.publicOrigin = `http://127.0.0.1:${config.listen.port}`;
  const request = (route, init) => fetch(config.publicOrigin + route, init);
  const jsonRequest = (route, method, body) => request(route, {method, headers: {'Content-Type': 'application/json', Origin: config.publicOrigin}, body: JSON.stringify(body)});
  try {
    let response = await request('/api/manage/hubs');
    assert.equal(response.status, 200);
    let data = await response.json();
    assert.equal(data.hubs.length, 1);
    assert.equal(data.hubs[0].hasSecret, true);
    assert.equal('secretRef' in data.hubs[0], false);
    assert.equal(JSON.stringify(data).includes('hub-one-secret'), false);
    assert.equal(JSON.stringify(data).includes(secretsPath), false);

    response = await jsonRequest('/api/manage/hubs/hub-1', 'PUT', {expectedVersion: 1, label: 'Renamed'});
    assert.equal(response.status, 200);
    data = await response.json();
    assert.equal(data.hub.version, 2);
    assert.equal(data.hub.label, 'Renamed');
    response = await jsonRequest('/api/manage/hubs/hub-1', 'PUT', {expectedVersion: 1, label: 'Stale'});
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {error: 'version_conflict', currentVersion: 2});

    response = await jsonRequest('/api/manage/hubs', 'POST', {id: 'hub-2', label: 'Hub Two', url: 'https://hub2.example.com', secret: 'hub-two-secret'});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).hub.version, 1);
    response = await jsonRequest('/api/manage/hubs/hub-1', 'DELETE', {expectedVersion: 2});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {error: 'hub_referenced_by_contract'});
    response = await jsonRequest('/api/manage/hubs/hub-2', 'PUT', {expectedVersion: 1, status: 'disabled'});
    assert.equal(response.status, 200);
    response = await jsonRequest('/api/manage/hubs/hub-2', 'DELETE', {expectedVersion: 2});
    assert.equal(response.status, 200);
    data = await (await request('/api/manage/hubs')).json();
    assert.equal(data.hubs.length, 1);
    data = await (await request('/api/manage/hubs?includeArchived=1')).json();
    assert.equal(data.hubs.length, 2);
    assert.equal(data.hubs.find(h => h.id === 'hub-2').status, 'archived');
    response = await jsonRequest('/api/manage/hubs/hub-2', 'POST', {});
    assert.equal(response.status, 405);
    response = await jsonRequest('/api/manage/hubs', 'POST', {id: 'hub-2', label: 'Reuse', url: 'https://reuse.example.com', secret: 'new-secret'});
    assert.equal(response.status, 409);
    assert.deepEqual((await response.json()).error, 'hub_id_exists');
  } finally {
    await app.close();
  }
});

test('missing Hub secrets stop collection and remain replaceable without leaking store errors', async t => {
  const dir = createTempDir(t);
  const databasePath = path.join(dir, 'analytics.db');
  const secretsPath = path.join(dir, 'hub-secrets.json');
  const db = openDatabase(databasePath);
  transaction(db,() => insertHub(db, {id: 'hub-missing', label: 'Missing', url: 'http://127.0.0.1:1', status: 'active', secretRef: 'missing'}));
  db.close();
  const raw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(raw, {demo: false, databasePath, hubSecretsPath: secretsPath, management: {enabled: true}, contracts: [], listen: {host: '127.0.0.1', port: 8787}});
  const config = loadConfig(writeConfig(dir, raw));
  config.listen.port = 0;
  const app = await startServer(config, {logger: {info() {}, error() {}}});
  config.listen.port = app.server.address().port;
  config.publicOrigin = `http://127.0.0.1:${config.listen.port}`;
  try {
    const response = await fetch(config.publicOrigin + '/api/manage/hubs');
    const body = await response.json();
    assert.equal(body.hubs[0].hasSecret, false);
    assert.equal(body.hubs[0].connection.errorCode, 'missing_secret');
    const reconnect = await fetch(config.publicOrigin + '/api/manage/hubs/hub-missing/reconnect', {method: 'POST', headers: {Origin: config.publicOrigin}});
    assert.equal(reconnect.status, 409);
    assert.deepEqual(await reconnect.json(), {error: 'missing_secret'});
  } finally {
    await app.close();
  }
});

test('a Hub DB failure after secret-file write exposes only an allowlisted error and leaves the old row', async t => {
  const dir = createTempDir(t);
  const databasePath = path.join(dir, 'analytics.db');
  const secretsPath = path.join(dir, 'hub-secrets.json');
  const raw = JSON.parse(fs.readFileSync(new URL('../configs/demo.json', import.meta.url), 'utf8'));
  Object.assign(raw, {demo: false, databasePath, hubSecretsPath: secretsPath, management: {enabled: true}, contracts: [], listen: {host: '127.0.0.1', port: 8787}});
  const config = loadConfig(writeConfig(dir, raw));
  config.listen.port = 0;
  const app = await startServer(config, {logger: {info() {}, error() {}}});
  config.listen.port = app.server.address().port;
  config.publicOrigin = `http://127.0.0.1:${config.listen.port}`;
  app.db.exec("CREATE TRIGGER fail_hub BEFORE INSERT ON hubs BEGIN SELECT RAISE(ABORT, 'SENSITIVE SQLITE DETAIL'); END;");
  try {
    const response = await fetch(config.publicOrigin + '/api/manage/hubs', {method: 'POST', headers: {Origin: config.publicOrigin, 'Content-Type': 'application/json'}, body: JSON.stringify({id: 'h1', label: 'Hub', url: 'https://hub.example.com', secret: 'new-secret'})});
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {error: 'save_failed'});
    assert.doesNotMatch(text, /SENSITIVE|SQLITE|hub-secrets|secret/);
    assert.equal(app.db.prepare('SELECT count(*) n FROM hubs').get().n, 0);
    assert.equal(readHubSecretStore(secretsPath).secrets && Object.keys(readHubSecretStore(secretsPath).secrets).length, 1);
  } finally {
    await app.close();
  }
});
