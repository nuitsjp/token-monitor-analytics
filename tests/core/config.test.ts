import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../../backend/config.ts';
test('port=0と明示DBパスで起動構成を作れる', () => { const config = readConfig({ HOST: '127.0.0.1', PORT: '0', DB_PATH: 'sandbox/example.sqlite', PUBLIC_ORIGIN: '' }); assert.equal(config.port, 0); assert.equal(config.publicOrigin, undefined); });
test('DBをWeb公開領域へ置かない', () => { assert.throws(() => readConfig({ DB_PATH: 'frontend/dist/data.sqlite' }), /Web公開/); });
test('未認証でのネットワーク公開を既定で許さない', () => { assert.throws(() => readConfig({ HOST: '0.0.0.0' }), /loopback/); });
