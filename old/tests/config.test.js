import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

const base = { BASIC_USER: 'viewer', BASIC_PASSWORD: 'local-test-password', HUB_ID: 'test', HUB_URL: 'https://example.test', HUB_SECRET: 'local-test-secret' };

test('configuration requires credentials and refuses secrets embedded in URLs', () => {
  for (const name of ['BASIC_USER', 'BASIC_PASSWORD', 'HUB_ID', 'HUB_URL', 'HUB_SECRET']) {
    assert.throws(() => readConfig({ ...base, [name]: '' }), error => error.message.includes(name));
  }
  for (const url of ['not-a-url', 'file:///tmp/hub', 'https://user:secret@example.test', 'https://example.test/?secret=private', 'https://example.test/#secret']) {
    assert.throws(() => readConfig({ ...base, HUB_URL: url }), error => !error.message.includes(url));
  }
  assert.throws(() => readConfig({ ...base, BASIC_USER: 'user:other' }));
  assert.throws(() => readConfig({ ...base, HUB_SECRET: 'secret\r\nAuthorization: anything' }));
});

test('configuration checks the port without exposing input secrets', () => {
  for (const port of ['0', '65536', 'NaN', '1.5']) assert.throws(() => readConfig({ ...base, PORT: port }));
  const config = readConfig(base);
  assert.equal(config.port, 17322);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.hub.url, base.HUB_URL);
});
