import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigurationError, loadConfiguration } from '../src/config.js';

function createRoot({ env = '', hubs = [], estimation } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'token-monitor-config-'));
  mkdirSync(path.join(root, '.local'));
  writeFileSync(path.join(root, '.env'), env, 'utf8');
  writeHubs(root, { hubs, estimation });
  return root;
}

function writeHubs(root, document) {
  writeFileSync(path.join(root, '.local', 'hubs.json'), JSON.stringify(document), 'utf8');
}

function cleanup(root) {
  const resolvedRoot = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(
    path.dirname(resolvedRoot).toLowerCase(),
    tempRoot.toLowerCase(),
    'test cleanup target must be directly under os.tmpdir()'
  );
  assert.equal(
    path.basename(resolvedRoot).startsWith('token-monitor-config-'),
    true,
    'test cleanup target must use the test prefix'
  );
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function assertConfigurationError(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

const validHub = { id: 'mock', url: 'http://127.0.0.1:8787', secret: 'mock-secret' };

test('loads a valid configuration with documented defaults', () => {
  const root = createRoot({ hubs: [validHub] });
  try {
    const configuration = loadConfiguration({ rootDir: root, env: {} });

    assert.equal(configuration.mode, 'real');
    assert.equal(configuration.host, '127.0.0.1');
    assert.equal(configuration.port, 3000);
    assert.equal(configuration.dbPath, path.join(root, 'data', 'real', 'analytics.sqlite'));
    assert.equal(configuration.configPath, path.join(root, '.local', 'hubs.json'));
    assert.equal(configuration.logPath, path.join(root, '.local', 'real.log'));
    assert.deepEqual(configuration.hubs, [{
      id: 'mock',
      url: validHub.url,
      secret: validHub.secret,
      configError: null
    }]);
    assert.deepEqual(configuration.estimation, { planMultipliers: [], error: null });
  } finally {
    cleanup(root);
  }
});

test('loads mock configuration without Hub configuration and isolates runtime paths', () => {
  const root = createRoot({ hubs: [validHub] });
  try {
    const configuration = loadConfiguration({ rootDir: root, env: {}, mode: 'mock' });

    assert.equal(configuration.mode, 'mock');
    assert.equal(configuration.host, '127.0.0.1');
    assert.equal(configuration.port, 3000);
    assert.equal(configuration.dbPath, path.join(root, 'data', 'mock', 'analytics.sqlite'));
    assert.equal(configuration.configPath, null);
    assert.equal(configuration.logPath, path.join(root, '.local', 'mock.log'));
    assert.deepEqual(configuration.hubs, []);
  } finally {
    cleanup(root);
  }
});

test('mock mode does not read or require the real Hub configuration file', () => {
  const root = createRoot({ hubs: [validHub] });
  const marker = 'sensitive-real-config-marker';
  try {
    writeFileSync(
      path.join(root, '.local', 'hubs.json'),
      `{"hubs":[{"id":"broken","secret":"${marker}`,
      'utf8'
    );

    const malformed = loadConfiguration({ rootDir: root, env: {}, mode: 'mock' });
    assert.deepEqual(malformed.hubs, []);
    assert.equal(JSON.stringify(malformed).includes(marker), false);

    rmSync(path.join(root, '.local', 'hubs.json'));
    const missing = loadConfiguration({ rootDir: root, env: {}, mode: 'mock' });
    assert.deepEqual(missing.hubs, []);
    assert.equal(missing.configPath, null);
  } finally {
    cleanup(root);
  }
});

test('rejects an invalid mode before reading any configuration file', () => {
  const root = createRoot({ hubs: [validHub] });
  try {
    rmSync(path.join(root, '.env'));
    rmSync(path.join(root, '.local', 'hubs.json'));
    assertConfigurationError(
      () => loadConfiguration({ rootDir: root, env: {}, mode: 'invalid' }),
      'mode_invalid'
    );
  } finally {
    cleanup(root);
  }
});

test('explicit environment values override .env, including a LAN IPv4 address', () => {
  const root = createRoot({
    env: 'ANALYTICS_HOST=127.0.0.1\nANALYTICS_PORT=3000\n',
    hubs: [validHub]
  });
  try {
    const configuration = loadConfiguration({
      rootDir: root,
      env: { ANALYTICS_HOST: '192.168.10.42', ANALYTICS_PORT: '8088' }
    });

    assert.equal(configuration.host, '192.168.10.42');
    assert.equal(configuration.port, 8088);
  } finally {
    cleanup(root);
  }
});

test('rejects malformed .env lines instead of silently using defaults', () => {
  const root = createRoot({
    env: 'ANALYTICS_HOST=127.0.0.1\nthis is not an assignment\n',
    hubs: [validHub]
  });
  try {
    assertConfigurationError(
      () => loadConfiguration({ rootDir: root, env: {} }),
      'environment_file_invalid'
    );
  } finally {
    cleanup(root);
  }
});

test('rejects non-IP hosts and ports outside the valid range without fallback', () => {
  const cases = [
    { env: 'ANALYTICS_HOST=localhost\n', code: 'host_invalid' },
    { env: 'ANALYTICS_PORT=0\n', code: 'port_invalid' },
    { env: 'ANALYTICS_PORT=65536\n', code: 'port_invalid' },
    { env: 'ANALYTICS_PORT=30.5\n', code: 'port_invalid' }
  ];

  for (const current of cases) {
    const root = createRoot({ env: current.env, hubs: [validHub] });
    try {
      assertConfigurationError(() => loadConfiguration({ rootDir: root, env: {} }), current.code);
    } finally {
      cleanup(root);
    }
  }

  const root = createRoot({
    env: 'ANALYTICS_HOST=127.0.0.1\nANALYTICS_PORT=3000\n',
    hubs: [validHub]
  });
  try {
    assertConfigurationError(
      () => loadConfiguration({ rootDir: root, env: { ANALYTICS_HOST: 'localhost' } }),
      'host_invalid'
    );
    assertConfigurationError(
      () => loadConfiguration({ rootDir: root, env: { ANALYTICS_PORT: '0' } }),
      'port_invalid'
    );
  } finally {
    cleanup(root);
  }
});

test('rejects whole-file structural errors', () => {
  const cases = [
    { document: [], code: 'configuration_structure_invalid' },
    { document: {}, code: 'hubs_array_invalid' },
    { document: { hubs: null }, code: 'hubs_array_invalid' },
    { document: { hubs: [null] }, code: 'hub_row_invalid' },
    { document: { hubs: [{ id: '', url: validHub.url, secret: validHub.secret }] }, code: 'hub_id_invalid' },
    {
      document: { hubs: [validHub, { ...validHub, url: 'http://127.0.0.1:8788' }] },
      code: 'hub_id_duplicate'
    }
  ];

  for (const current of cases) {
    const root = createRoot({ hubs: [] });
    try {
      writeHubs(root, current.document);
      assertConfigurationError(() => loadConfiguration({ rootDir: root, env: {} }), current.code);
    } finally {
      cleanup(root);
    }
  }
});

test('does not expose malformed JSON text in a configuration error', () => {
  const root = createRoot({ hubs: [validHub] });
  const marker = 'sensitive-config-marker';
  try {
    writeFileSync(
      path.join(root, '.local', 'hubs.json'),
      `{"hubs":[{"id":"broken","secret":"${marker}`,
      'utf8'
    );

    let caught;
    try {
      loadConfiguration({ rootDir: root, env: {} });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ConfigurationError, true);
    assert.equal(caught.code, 'configuration_file_invalid_json');
    assert.equal(caught.message.includes(marker), false);
  } finally {
    cleanup(root);
  }
});

test('keeps valid hubs when another hub has invalid URL or secret', () => {
  const invalidSecret = 'secret-with-newline\r\nX-Leak: yes';
  const root = createRoot({
    hubs: [
      validHub,
      { id: 'bad-url', url: 'ftp://127.0.0.1:8787', secret: 'still-valid' },
      { id: 'bad-secret', url: 'http://127.0.0.1:8788', secret: invalidSecret },
      { id: 'bad-both', url: 'http://user:pass@127.0.0.1:8789/?query=1', secret: '' }
    ]
  });
  try {
    const configuration = loadConfiguration({ rootDir: root, env: {} });

    assert.equal(configuration.hubs.length, 4);
    assert.equal(configuration.hubs[0].configError, null);

    assert.equal(configuration.hubs[1].url, null);
    assert.equal(configuration.hubs[1].secret, 'still-valid');
    assert.equal(configuration.hubs[1].configError, 'invalid_url');

    assert.equal(configuration.hubs[2].url, 'http://127.0.0.1:8788');
    assert.equal(configuration.hubs[2].secret, null);
    assert.equal(configuration.hubs[2].configError, 'invalid_secret');

    assert.equal(configuration.hubs[3].url, null);
    assert.equal(configuration.hubs[3].secret, null);
    assert.equal(configuration.hubs[3].configError, 'invalid_url;invalid_secret');
    assert.equal(JSON.stringify(configuration).includes(invalidSecret), false);
  } finally {
    cleanup(root);
  }
});

test('keeps estimation errors separate from Hub connection configuration errors', () => {
  const root = createRoot({
    hubs: [validHub, { ...validHub, id: 'second' }],
    estimation: { planMultipliers: [{ tool: 'codex', windowKey: 'five_hour', basePlan: 'Plus', plans: { Plus: 0, Pro: 5 } }] }
  });
  try {
    const configuration = loadConfiguration({ rootDir: root, env: {} });

    assert.equal(configuration.hubs[0].configError, null);
    assert.equal(configuration.hubs[1].configError, null);
    assert.deepEqual(configuration.estimation, {
      planMultipliers: [],
      error: '推定設定の形式が不正です。'
    });
  } finally {
    cleanup(root);
  }
});

test('loads shared estimation settings and rejects the obsolete per-Hub location', () => {
  const estimation = { planMultipliers: [{ tool: 'codex', windowKey: 'weekly', basePlan: 'Plus', plans: { Plus: 1, Pro: 5 } }] };
  const root = createRoot({ hubs: [validHub], estimation });
  try {
    assert.deepEqual(loadConfiguration({ rootDir: root, env: {} }).estimation, { ...estimation, error: null });
    writeFileSync(path.join(root, '.local', 'hubs.json'), JSON.stringify({ hubs: [{ ...validHub, estimation }] }));
    assertConfigurationError(() => loadConfiguration({ rootDir: root, env: {} }), 'hub_estimation_must_be_top_level');
  } finally { cleanup(root); }
});

test('rejects a missing required .env or Hub configuration file', () => {
  const root = createRoot({ hubs: [validHub] });
  try {
    rmSync(path.join(root, '.env'));
    assertConfigurationError(() => loadConfiguration({ rootDir: root, env: {} }), 'environment_file_unreadable');
  } finally {
    cleanup(root);
  }

  const secondRoot = createRoot({ hubs: [validHub] });
  try {
    rmSync(path.join(secondRoot, '.local', 'hubs.json'));
    assertConfigurationError(
      () => loadConfiguration({ rootDir: secondRoot, env: {} }),
      'configuration_file_unreadable'
    );
  } finally {
    cleanup(secondRoot);
  }
});

test('ignores unknown Hub keys while returning only the configuration contract', () => {
  const root = createRoot({
    hubs: [{ ...validHub, displayName: 'ignored', extra: { nested: true } }]
  });
  try {
    const configuration = loadConfiguration({ rootDir: root, env: {} });
    assert.deepEqual(Object.keys(configuration.hubs[0]).sort(), ['configError', 'id', 'secret', 'url']);
    assert.equal(readFileSync(path.join(root, '.local', 'hubs.json'), 'utf8').includes('ignored'), true);
  } finally {
    cleanup(root);
  }
});
