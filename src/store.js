import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { advanceEstimation, interruptEstimation, seedEstimation } from './estimation.js';
import { contractId, contractScope, contractAccountKey, deviceKey } from './identity.js';
import { buildMetrics } from './metrics.js';

const SCHEMA_VERSION = 6;
const SCHEMA_COLUMNS = Object.freeze({
  hubs: [
    ['id', 'TEXT', 1, 1],
    ['collection_enabled', 'INTEGER', 1, 0],
    ['received_at', 'TEXT', 0, 0],
    ['aggregate_json', 'TEXT', 0, 0]
  ],
  observations: [
    ['id', 'INTEGER', 0, 1],
    ['hub_id', 'TEXT', 1, 0],
    ['device_id', 'TEXT', 1, 0],
    ['comparison_json', 'TEXT', 1, 0],
    ['observation_json', 'TEXT', 1, 0]
  ],
  current_devices: [
    ['hub_id', 'TEXT', 1, 1],
    ['device_id', 'TEXT', 1, 2],
    ['observation_id', 'INTEGER', 1, 0],
    ['received_at', 'TEXT', 1, 0],
    ['present', 'INTEGER', 1, 0],
    ['metadata_json', 'TEXT', 1, 0]
  ],
  estimation_hubs: [
    ['hub_id', 'TEXT', 1, 1],
    ['state_json', 'TEXT', 1, 0]
  ],
  estimation_events: [
    ['id', 'INTEGER', 0, 1],
    ['hub_id', 'TEXT', 1, 0],
    ['series_id', 'TEXT', 1, 0],
    ['recorded_at', 'TEXT', 1, 0],
    ['status', 'TEXT', 1, 0],
    ['event_json', 'TEXT', 1, 0]
  ],
  contracts: [
    ['id', 'TEXT', 1, 1],
    ['provider', 'TEXT', 1, 0],
    ['account_key', 'TEXT', 1, 0],
    ['scope_hub_id', 'TEXT', 1, 0]
  ],
  device_contracts: [
    ['hub_id', 'TEXT', 1, 1],
    ['device_id', 'TEXT', 1, 2],
    ['tool', 'TEXT', 1, 3],
    ['contract_id', 'TEXT', 1, 4],
    ['first_observation_id', 'INTEGER', 0, 0],
    ['last_observation_id', 'INTEGER', 0, 0]
  ],
  shared_estimation_state: [
    ['id', 'INTEGER', 0, 1],
    ['state_json', 'TEXT', 1, 0]
  ],
  shared_estimation_events: [
    ['id', 'INTEGER', 0, 1],
    ['series_id', 'TEXT', 1, 0],
    ['recorded_at', 'TEXT', 1, 0],
    ['status', 'TEXT', 1, 0],
    ['event_json', 'TEXT', 1, 0]
  ]
});

const V1_SCHEMA_TABLES = Object.freeze(['hubs', 'observations', 'current_devices']);
const V2_SCHEMA_TABLES = Object.freeze([...V1_SCHEMA_TABLES, 'estimation_hubs', 'estimation_events']);
const SCHEMA_INDEXES = Object.freeze({
  observations_by_device: Object.freeze({
    table: 'observations',
    columns: Object.freeze(['hub_id', 'device_id', 'id']),
    unique: 0
  }),
  estimation_events_by_series: Object.freeze({
    table: 'estimation_events',
    columns: Object.freeze(['hub_id', 'series_id', 'id']),
    unique: 0
  }),
  contracts_by_identity: Object.freeze({
    table: 'contracts', columns: Object.freeze(['scope_hub_id', 'provider', 'account_key']), unique: 1
  }),
  device_contracts_by_contract: Object.freeze({
    table: 'device_contracts', columns: Object.freeze(['contract_id', 'hub_id', 'device_id']), unique: 0
  }),
  shared_estimation_events_by_series: Object.freeze({
    table: 'shared_estimation_events', columns: Object.freeze(['series_id', 'id']), unique: 0
  })
});
const SCHEMA_FOREIGN_KEYS = Object.freeze({
  observations: Object.freeze([['hubs', 'hub_id', 'id']]),
  current_devices: Object.freeze([
    ['hubs', 'hub_id', 'id'],
    ['observations', 'observation_id', 'id']
  ]),
  estimation_hubs: Object.freeze([['hubs', 'hub_id', 'id']]),
  estimation_events: Object.freeze([['hubs', 'hub_id', 'id']]),
  device_contracts: Object.freeze([
    ['current_devices', 'hub_id', 'hub_id'], ['current_devices', 'device_id', 'device_id'],
    ['contracts', 'contract_id', 'id'],
    ['observations', 'first_observation_id', 'id'], ['observations', 'last_observation_id', 'id']
  ])
});

const SHARED_SCHEMA_SQL = `
  CREATE TABLE contracts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_key TEXT NOT NULL,
    scope_hub_id TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX contracts_by_identity ON contracts (scope_hub_id, provider, account_key);
  CREATE TABLE device_contracts (
    hub_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    first_observation_id INTEGER,
    last_observation_id INTEGER,
    PRIMARY KEY (hub_id, device_id, tool, contract_id),
    FOREIGN KEY (hub_id, device_id) REFERENCES current_devices(hub_id, device_id),
    FOREIGN KEY (contract_id) REFERENCES contracts(id),
    FOREIGN KEY (first_observation_id) REFERENCES observations(id),
    FOREIGN KEY (last_observation_id) REFERENCES observations(id)
  ) STRICT;
  CREATE INDEX device_contracts_by_contract ON device_contracts (contract_id, hub_id, device_id);
  CREATE TABLE shared_estimation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE shared_estimation_events (
    id INTEGER PRIMARY KEY,
    series_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    status TEXT NOT NULL,
    event_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX shared_estimation_events_by_series ON shared_estimation_events (series_id, id);
`;

function schemaError() {
  return new Error('database schema is incompatible');
}

function rollbackQuietly(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the error that caused the transaction to fail.
  }
}

function createSchema(db) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE hubs (
      id TEXT PRIMARY KEY,
      collection_enabled INTEGER NOT NULL CHECK (collection_enabled IN (0, 1)),
      received_at TEXT,
      aggregate_json TEXT
    ) STRICT;
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      hub_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      comparison_json TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE INDEX observations_by_device
      ON observations (hub_id, device_id, id);
    CREATE TABLE current_devices (
      hub_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      observation_id INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      present INTEGER NOT NULL CHECK (present IN (0, 1)),
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (hub_id, device_id),
      FOREIGN KEY (hub_id) REFERENCES hubs(id),
      FOREIGN KEY (observation_id) REFERENCES observations(id)
    ) STRICT;
    CREATE TABLE estimation_hubs (
      hub_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE TABLE estimation_events (
      id INTEGER PRIMARY KEY,
      hub_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      FOREIGN KEY (hub_id) REFERENCES hubs(id)
    ) STRICT;
    CREATE INDEX estimation_events_by_series
      ON estimation_events (hub_id, series_id, id);
    ${SHARED_SCHEMA_SQL}
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

function assertColumns(db, tables) {
  for (const table of tables) {
    const expectedColumns = SCHEMA_COLUMNS[table];
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (
      columns.length !== expectedColumns.length
      || columns.some((column, index) => {
        const [name, type, notNull, primaryKey] = expectedColumns[index];
        return column.name !== name
          || column.type !== type
          || column.notnull !== notNull
          || column.pk !== primaryKey;
      })
    ) {
      throw schemaError();
    }
  }
}

function assertIndexes(db, indexes) {
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = db.prepare(`PRAGMA index_list(${expected.table})`).all()
      .find((index) => index.name === name);
    if (!listed || listed.unique !== expected.unique || listed.partial !== 0) {
      throw schemaError();
    }

    const columns = db.prepare(`PRAGMA index_info(${name})`).all()
      .sort((left, right) => left.seq - right.seq)
      .map((column) => column.name);
    if (columns.length !== expected.columns.length
      || columns.some((column, index) => column !== expected.columns[index])) {
      throw schemaError();
    }
  }
}

function assertForeignKeys(db, tables) {
  for (const table of tables) {
    const expected = SCHEMA_FOREIGN_KEYS[table] ?? [];
    const actual = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map((foreignKey) => [foreignKey.table, foreignKey.from, foreignKey.to])
      .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
    const expectedSorted = expected.map((foreignKey) => [...foreignKey])
      .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
    if (actual.length !== expectedSorted.length
      || actual.some((foreignKey, index) => foreignKey.some((value, part) => value !== expectedSorted[index][part]))) {
      throw schemaError();
    }
  }
}

function assertSchema(db, tables, indexes) {
  assertColumns(db, tables);
  assertIndexes(db, indexes);
  assertForeignKeys(db, tables);
}

function migrateSchema(db, version) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 1) db.exec(`
      CREATE TABLE estimation_hubs (
        hub_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        FOREIGN KEY (hub_id) REFERENCES hubs(id)
      ) STRICT;
      CREATE TABLE estimation_events (
        id INTEGER PRIMARY KEY,
        hub_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        status TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY (hub_id) REFERENCES hubs(id)
      ) STRICT;
      CREATE INDEX estimation_events_by_series
        ON estimation_events (hub_id, series_id, id);
    `);
    db.exec(SHARED_SCHEMA_SQL);
    const link = relationWriter(db);
    for (const row of db.prepare('SELECT id, hub_id, device_id, observation_json FROM observations ORDER BY id').iterate()) {
      const observation = parseStoredJson(row.observation_json);
      for (const provider of observation.limits?.providers ?? []) {
        link(row.hub_id, row.device_id, provider, row.id);
      }
    }
    // The old registry can retain a known relationship whose exact observation is unknown.
    for (const row of db.prepare('SELECT hub_id, state_json FROM estimation_hubs').all()) {
      for (const source of parseStoredJson(row.state_json).registry ?? []) {
        for (const account of source.accounts) link(row.hub_id, source.deviceId, { provider: source.tool, accountKey: account }, null);
      }
    }
    const devices = readDevices(db);
    if (devices.length) {
      const seeded = seedEstimation({ devices, registry: readRegistry(db), receivedAt: new Date().toISOString() });
      db.prepare('INSERT INTO shared_estimation_state (id, state_json) VALUES (1, ?)').run(JSON.stringify(seeded.state));
    }
    assertSchema(db, Object.keys(SCHEMA_COLUMNS), SCHEMA_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function assertCompatibleSchema(db) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 1 || version === 2) {
    const indexes = { observations_by_device: SCHEMA_INDEXES.observations_by_device };
    if (version === 2) indexes.estimation_events_by_series = SCHEMA_INDEXES.estimation_events_by_series;
    assertSchema(db, version === 1 ? V1_SCHEMA_TABLES : V2_SCHEMA_TABLES, indexes);
    migrateSchema(db, version);
    return;
  }
  if (![3, 4, 5, SCHEMA_VERSION].includes(version)) throw schemaError();
  assertSchema(db, Object.keys(SCHEMA_COLUMNS), SCHEMA_INDEXES);
  if (version === 3) migrateGrokContracts(db);
  if (version === 3 || version === 4) migrateContractScopes(db);
  if (version < 6) migrateUsagePolicy(db);
}

function migrateGrokContracts(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // These are derived relationships. Raw observations and estimation events stay intact.
    db.exec("DELETE FROM device_contracts WHERE tool = 'grok'; DELETE FROM contracts WHERE provider = 'grok';");
    const link = relationWriter(db);
    for (const row of db.prepare('SELECT id, hub_id, device_id, observation_json FROM observations ORDER BY id').iterate()) {
      for (const provider of parseStoredJson(row.observation_json).limits?.providers ?? []) {
        if (provider.provider === 'grok') link(row.hub_id, row.device_id, provider, row.id);
      }
    }
    const checkpoint = db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
    if (checkpoint) {
      const state = parseStoredJson(checkpoint.state_json);
      const seeded = seedEstimation({ devices: readDevices(db), registry: readRegistry(db), receivedAt: new Date().toISOString() }).state;
      // Rebuild Grok's current metadata and wait for fresh observations;
      // keep every other provider's comparison points and all saved events.
      state.registry = [...state.registry.filter((source) => source.tool !== 'grok'), ...seeded.registry.filter((source) => source.tool === 'grok')];
      state.groups = [...state.groups.filter((group) => group.view.tool !== 'grok'), ...seeded.groups.filter((group) => group.view.tool === 'grok')];
      db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
    }
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function migrateContractScopes(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const contracts = db.prepare("SELECT * FROM contracts WHERE scope_hub_id <> ''").all();
    const changedTools = new Set(contracts.map((contract) => contract.provider));
    const insertContract = db.prepare('INSERT INTO contracts (id, provider, account_key, scope_hub_id) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
    const insertRelation = db.prepare(`INSERT INTO device_contracts VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (hub_id, device_id, tool, contract_id) DO UPDATE SET
      first_observation_id = CASE WHEN excluded.first_observation_id IS NULL THEN first_observation_id
        WHEN first_observation_id IS NULL THEN excluded.first_observation_id
        ELSE MIN(first_observation_id, excluded.first_observation_id) END,
      last_observation_id = CASE WHEN excluded.last_observation_id IS NULL THEN last_observation_id
        WHEN last_observation_id IS NULL THEN excluded.last_observation_id
        ELSE MAX(last_observation_id, excluded.last_observation_id) END`);
    for (const contract of contracts) {
      const id = contractId(contract.provider, contract.account_key, '');
      insertContract.run(id, contract.provider, contract.account_key, '');
      for (const relation of db.prepare('SELECT * FROM device_contracts WHERE contract_id = ?').all(contract.id)) {
        insertRelation.run(relation.hub_id, relation.device_id, relation.tool, id, relation.first_observation_id, relation.last_observation_id);
      }
      db.prepare('DELETE FROM device_contracts WHERE contract_id = ?').run(contract.id);
      db.prepare('DELETE FROM contracts WHERE id = ?').run(contract.id);
    }
    const checkpoint = db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
    if (checkpoint && changedTools.size) {
      const state = parseStoredJson(checkpoint.state_json);
      const seeded = seedEstimation({ devices: readDevices(db), registry: readRegistry(db), receivedAt: new Date().toISOString() }).state;
      state.registry = [...state.registry.filter((source) => !changedTools.has(source.tool)), ...seeded.registry.filter((source) => changedTools.has(source.tool))];
      state.groups = [...state.groups.filter((group) => !changedTools.has(group.view.tool)), ...seeded.groups.filter((group) => changedTools.has(group.view.tool))];
      db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
    }
    db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function migrateUsagePolicy(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const checkpoint = db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
    if (checkpoint) {
      const old = parseStoredJson(checkpoint.state_json);
      const seeded = seedEstimation({ devices: readDevices(db), registry: readRegistry(db), receivedAt: new Date().toISOString() }).state;
      const freshIds = new Set(seeded.groups.map(group => group.id));
      const archived = old.groups.filter(group => !freshIds.has(group.id)).map(group => ({
        ...group, baseline: null, latest: null,
        view: { ...group.view, active: false, reason: 'method_changed', message: '集計方法の変更前の記録です。現在の推定には使いません。' },
      }));
      seeded.groups.push(...archived);
      db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(seeded));
    }
    db.exec('PRAGMA user_version = 6');
    db.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function validateHubIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError('hub ids must be an array');
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('hub id must be a non-empty string');
    }
  }
  return [...new Set(ids)];
}

function validateReceivedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('analytics received time must be a valid timestamp');
  }
}

function validateNormalizedNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('normalized notification must be an object');
  }
  if (!value.hubCurrent || typeof value.hubCurrent !== 'object' || Array.isArray(value.hubCurrent)) {
    throw new TypeError('normalized hub current data must be an object');
  }
  if (!Array.isArray(value.devices)) {
    throw new TypeError('normalized devices must be an array');
  }
}

function parseStoredJson(value) {
  return value === null ? null : JSON.parse(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateEstimationResult(result) {
  if (!isPlainObject(result) || !Array.isArray(result.events)) {
    throw new TypeError('estimation result is invalid');
  }
  if (result.state !== null && !isPlainObject(result.state)) {
    throw new TypeError('estimation state is invalid');
  }
}

function serializeEstimationState(state) {
  if (state === null) return null;
  const stateJson = JSON.stringify(state);
  if (typeof stateJson !== 'string') throw new TypeError('estimation state is not serializable');
  return stateJson;
}

function serializeEstimationEvent(event) {
  if (!isPlainObject(event)
    || typeof event.seriesId !== 'string'
    || event.seriesId.length === 0
    || typeof event.recordedAt !== 'string'
    || event.recordedAt.length === 0
    || typeof event.status !== 'string'
    || event.status.length === 0) {
    throw new TypeError('estimation event is invalid');
  }
  const eventJson = JSON.stringify(event);
  if (typeof eventJson !== 'string') throw new TypeError('estimation event is not serializable');
  return {
    seriesId: event.seriesId,
    recordedAt: event.recordedAt,
    status: event.status,
    eventJson
  };
}

function persistEstimation(result, upsertState, insertEvent) {
  validateEstimationResult(result);
  const stateJson = serializeEstimationState(result.state);
  if (stateJson !== null) upsertState.run(stateJson);
  for (const event of result.events) {
    const serialized = serializeEstimationEvent(event);
    insertEvent.run(
      serialized.seriesId,
      serialized.recordedAt,
      serialized.status,
      serialized.eventJson
    );
  }
}

function readDevices(db) {
  return db.prepare(`
    SELECT d.*, o.observation_json FROM current_devices d
    JOIN observations o ON o.id = d.observation_id
    ORDER BY d.hub_id, d.device_id
  `).all().map((row) => ({
    hubId: row.hub_id, deviceId: row.device_id, observationId: row.observation_id,
    receivedAt: row.received_at, present: row.present === 1,
    metadata: parseStoredJson(row.metadata_json), observation: parseStoredJson(row.observation_json),
  }));
}

function readRegistry(db) {
  const sources = new Map();
  for (const row of db.prepare('SELECT hub_id, device_id, tool, contract_id FROM device_contracts ORDER BY hub_id, device_id, tool, contract_id').all()) {
    const key = JSON.stringify([row.hub_id, row.device_id, row.tool]);
    if (!sources.has(key)) sources.set(key, { hubId: row.hub_id, deviceId: row.device_id, tool: row.tool, accounts: [] });
    sources.get(key).accounts.push(row.contract_id);
  }
  return [...sources.values()];
}

function currentGrokKeys(providers) {
  const reports = providers.filter((provider) => provider.provider === 'grok');
  const successful = reports.filter((provider) => provider.status === 'ok');
  const latestAt = Math.max(...reports.map((provider) => Date.parse(provider.updatedAt) || 0));
  const current = successful.length ? successful
    : reports.filter((provider) => (Date.parse(provider.updatedAt) || 0) === latestAt
      && !['notConfigured', 'disabled'].includes(provider.status));
  return new Set(current.map(contractAccountKey).filter(Boolean));
}

function comparableWindows(provider) {
  if (provider.provider !== 'grok') return JSON.stringify(provider.windows);
  return JSON.stringify((provider.windows ?? []).map((window) => JSON.stringify([
    window.kind, window.limitId, window.metric, window.windowMinutes,
    window.usedPercent, window.remainingPercent, window.used, window.limit, window.remaining,
    window.resetsAt ? Date.parse(window.resetsAt) : null,
  ])).sort());
}

function relationWriter(db) {
  const insertContract = db.prepare(`INSERT INTO contracts (id, provider, account_key, scope_hub_id)
    VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`);
  const upsertRelation = db.prepare(`INSERT INTO device_contracts
    (hub_id, device_id, tool, contract_id, first_observation_id, last_observation_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (hub_id, device_id, tool, contract_id) DO UPDATE SET
      first_observation_id = COALESCE(device_contracts.first_observation_id, excluded.first_observation_id),
      last_observation_id = CASE WHEN excluded.last_observation_id IS NULL THEN device_contracts.last_observation_id
        WHEN device_contracts.last_observation_id IS NULL THEN excluded.last_observation_id
        ELSE MAX(device_contracts.last_observation_id, excluded.last_observation_id) END`);
  return (hubId, deviceId, provider, observationId) => {
    const tool = provider.provider;
    const accountKey = contractAccountKey(provider);
    if (!accountKey) return;
    const id = contractId(tool, accountKey, hubId);
    insertContract.run(id, tool, accountKey, contractScope(tool, hubId));
    upsertRelation.run(hubId, deviceId, tool, id, observationId, observationId);
  };
}

function estimationStatements(db) {
  return {
    select: db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1'),
    upsert: db.prepare(`INSERT INTO shared_estimation_state (id, state_json) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json`),
    insert: db.prepare(`INSERT INTO shared_estimation_events (series_id, recorded_at, status, event_json)
      VALUES (?, ?, ?, ?)`),
  };
}

export class AnalyticsStore {
  #db;
  #closed = false;
  #estimationSettings;
  #hubGaps = new Map();

  constructor(dbPath, { estimationSettings = {} } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new TypeError('database path must be a non-empty string');
    }
    if (!isPlainObject(estimationSettings)) {
      throw new TypeError('estimation settings must be an object');
    }

    const isNew = dbPath === ':memory:' || !existsSync(dbPath);
    if (isNew && dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');
      if (isNew) createSchema(db);
      else assertCompatibleSchema(db);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Keep the database open/validation error as the reported cause.
      }
      throw error;
    }
    this.#db = db;
    this.#estimationSettings = estimationSettings;
  }

  registerHubs(ids) {
    const uniqueIds = validateHubIds(ids);
    const insert = this.#db.prepare(`
      INSERT INTO hubs (id, collection_enabled, received_at, aggregate_json)
      VALUES (?, 1, NULL, NULL)
      ON CONFLICT (id) DO NOTHING
    `);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of uniqueIds) insert.run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  readState() {
    const hubs = this.#db.prepare(`
      SELECT id, collection_enabled, received_at, aggregate_json
      FROM hubs
      ORDER BY id
    `).all();
    const devices = readDevices(this.#db);
    const byDevice = new Map(devices.map((device) => [deviceKey(device.hubId, device.deviceId), device]));
    const checkpoint = this.#db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
    const estimates = checkpoint ? parseStoredJson(checkpoint.state_json).groups.map((group) => group.view) : [];
    const relations = this.#db.prepare('SELECT * FROM device_contracts ORDER BY hub_id, device_id, tool').all();
    const contracts = this.#db.prepare('SELECT * FROM contracts ORDER BY provider, id').all().map((contract) => {
      const sources = relations.filter((row) => row.contract_id === contract.id).map((row) => {
        const device = byDevice.get(deviceKey(row.hub_id, row.device_id));
        return {
          hubId: row.hub_id, deviceId: row.device_id, tool: row.tool,
          firstObservationId: row.first_observation_id, lastObservationId: row.last_observation_id,
          present: device.present, stale: device.metadata.stale === true,
          current: device.present && (device.observation.limits?.providers ?? []).some((provider) =>
            provider.provider === contract.provider && contractAccountKey(provider) === contract.account_key
              && (contract.provider !== 'grok' || currentGrokKeys(device.observation.limits.providers).has(contract.account_key))),
        };
      });
      const reports = sources.flatMap((source) => {
        const device = byDevice.get(deviceKey(source.hubId, source.deviceId));
        return (device.observation.limits?.providers ?? [])
          .filter((provider) => provider.provider === contract.provider && contractAccountKey(provider) === contract.account_key)
          .map((provider) => ({ device, provider }));
      }).sort((a, b) => (Date.parse(b.provider.updatedAt) || 0) - (Date.parse(a.provider.updatedAt) || 0));
      const healthy = reports.filter(({ device, provider }) => device.present && device.metadata.stale !== true
        && provider.status === 'ok' && provider.stale !== true && !this.#hubGaps.has(device.hubId));
      const selected = healthy[0] ?? reports[0];
      let providerData = selected ? { ...selected.provider } : null;
      if (providerData && !healthy.length && providerData.status === 'ok') {
        providerData.status = this.#hubGaps.get(selected.device.hubId) ?? 'stale';
        providerData.stale = true;
      }
      if (healthy.some((report) => Date.parse(report.provider.updatedAt) === Date.parse(selected?.provider.updatedAt)
        && comparableWindows(report.provider) !== comparableWindows(selected.provider))) {
        providerData = { ...providerData, status: 'conflicting_rate' };
      }
      return {
        id: contract.id, provider: contract.provider, accountKey: contract.account_key,
        label: selected ? selected.provider.accountLabel || selected.provider.accountName || selected.provider.planLabel || '契約名未取得'
          : '以前に観測した契約',
        plan: selected?.provider.planLabel || (contract.provider === 'codex' ? selected?.provider.accountLabel : null) || null,
        hubIds: [...new Set(sources.map((source) => source.hubId))].sort(), sources,
        current: sources.some((source) => source.current), providerData,
        receivedAt: selected?.device.receivedAt ?? null,
      };
    });

    const aggregates = hubs.map(hub => ({ id: hub.id, aggregate: parseStoredJson(hub.aggregate_json) }));
    const metrics = buildMetrics(aggregates, devices, readRegistry(this.#db));
    return {
      contracts, estimates, metrics: metrics.global,
      legacyEstimateCount: this.#db.prepare('SELECT COUNT(*) AS count FROM estimation_events').get().count,
      hubs: hubs.map((hub) => ({
        id: hub.id,
        collectionEnabled: hub.collection_enabled === 1,
        receivedAt: hub.received_at,
        aggregate: parseStoredJson(hub.aggregate_json),
        metrics: metrics.byHub.get(hub.id),
        devices: devices.filter((device) => device.hubId === hub.id),
        contractIds: contracts.filter((contract) => contract.hubIds.includes(hub.id)).map((contract) => contract.id),
        estimateIds: estimates.filter((estimate) => estimate.hubIds.includes(hub.id)).map((estimate) => estimate.id),
      }))
    };
  }

  commitNotification(hubId, normalized, analyticsReceivedAt) {
    if (typeof hubId !== 'string' || hubId.length === 0) {
      throw new TypeError('hub id must be a non-empty string');
    }
    validateNormalizedNotification(normalized);
    validateReceivedAt(analyticsReceivedAt);

    const updateHub = this.#db.prepare(`
      UPDATE hubs
      SET received_at = ?, aggregate_json = ?
      WHERE id = ?
    `);
    const markDevicesMissing = this.#db.prepare(`
      UPDATE current_devices
      SET present = 0
      WHERE hub_id = ?
    `);
    const findCurrent = this.#db.prepare(`
      SELECT current_devices.observation_id, observations.comparison_json
      FROM current_devices
      JOIN observations ON observations.id = current_devices.observation_id
      WHERE current_devices.hub_id = ? AND current_devices.device_id = ?
    `);
    const insertObservation = this.#db.prepare(`
      INSERT INTO observations (hub_id, device_id, comparison_json, observation_json)
      VALUES (?, ?, ?, ?)
    `);
    const upsertCurrent = this.#db.prepare(`
      INSERT INTO current_devices (
        hub_id, device_id, observation_id, received_at, present, metadata_json
      ) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT (hub_id, device_id) DO UPDATE SET
        observation_id = excluded.observation_id,
        received_at = excluded.received_at,
        present = 1,
        metadata_json = excluded.metadata_json
    `);
    const estimation = estimationStatements(this.#db);
    const link = relationWriter(this.#db);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previousEstimation = estimation.select.get();
      const previousState = previousEstimation === undefined
        ? null
        : parseStoredJson(previousEstimation.state_json);
      const aggregateJson = JSON.stringify(normalized.hubCurrent);
      const hubUpdate = updateHub.run(analyticsReceivedAt, aggregateJson, hubId);
      if (hubUpdate.changes !== 1) throw new Error('hub is not registered');

      markDevicesMissing.run(hubId);

      for (const device of normalized.devices) {
        if (!device || typeof device !== 'object' || typeof device.deviceId !== 'string') {
          throw new TypeError('normalized device is invalid');
        }
        if (typeof device.comparisonJson !== 'string') {
          throw new TypeError('normalized comparison must be a string');
        }

        const current = findCurrent.get(hubId, device.deviceId);
        let observationId = current?.observation_id;
        if (!current || current.comparison_json !== device.comparisonJson) {
          const result = insertObservation.run(
            hubId,
            device.deviceId,
            device.comparisonJson,
            JSON.stringify(device.observation)
          );
          observationId = result.lastInsertRowid;
        }

        upsertCurrent.run(
          hubId,
          device.deviceId,
          observationId,
          analyticsReceivedAt,
          JSON.stringify(device.metadata)
        );
        for (const provider of device.observation.limits?.providers ?? []) {
          link(hubId, device.deviceId, provider, observationId);
        }
      }

      const estimationDevices = readDevices(this.#db).map((device) => ({
        ...device,
        gapReason: device.hubId === hubId ? undefined : this.#hubGaps.get(device.hubId),
      }));
      const estimationResult = advanceEstimation(
        previousState,
        { devices: estimationDevices, registry: readRegistry(this.#db), receivedAt: analyticsReceivedAt },
        this.#estimationSettings
      );
      persistEstimation(
        estimationResult,
        estimation.upsert,
        estimation.insert
      );

      this.#db.exec('COMMIT');
      this.#hubGaps.delete(hubId);
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  markEstimationGap(hubId, reason, at) {
    if (typeof hubId !== 'string' || hubId.length === 0) {
      throw new TypeError('hub id must be a non-empty string');
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new TypeError('estimation gap reason must be a non-empty string');
    }
    validateReceivedAt(at);

    const selectHub = this.#db.prepare('SELECT 1 AS present FROM hubs WHERE id = ?');
    const estimation = estimationStatements(this.#db);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (selectHub.get(hubId) === undefined) throw new Error('hub is not registered');
      const previousEstimation = estimation.select.get();
      const previousState = previousEstimation === undefined
        ? null
        : parseStoredJson(previousEstimation.state_json);
      const result = interruptEstimation(
        previousState,
        { hubId, at, reason }
      );
      persistEstimation(
        result,
        estimation.upsert,
        estimation.insert
      );
      this.#db.exec('COMMIT');
      this.#hubGaps.set(hubId, reason);
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  readEstimationHistory({ hubId, seriesId, beforeId, limit = 50, scope = 'global' } = {}) {
    if (!['global', 'legacy'].includes(scope)) throw new TypeError('invalid estimation history scope');
    const conditions = [];
    const parameters = [];
    if (hubId !== undefined && hubId !== null) {
      conditions.push(scope === 'legacy' ? 'hub_id = ?'
        : "EXISTS (SELECT 1 FROM json_each(event_json, '$.view.hubIds') WHERE value = ?)");
      parameters.push(hubId);
    }
    if (seriesId !== undefined && seriesId !== null) {
      conditions.push('series_id = ?');
      parameters.push(seriesId);
    }
    if (beforeId !== undefined && beforeId !== null) {
      conditions.push('id < ?');
      parameters.push(beforeId);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.#db.prepare(`
      SELECT id, event_json${scope === 'legacy' ? ', hub_id' : ''}
      FROM ${scope === 'legacy' ? 'estimation_events' : 'shared_estimation_events'}
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...parameters, limit + 1);
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      ...parseStoredJson(row.event_json),
      id: row.id, scope,
      ...(scope === 'legacy' ? { hubId: row.hub_id } : {}),
    }));
    return {
      items,
      nextCursor: hasNext ? rows[limit - 1].id : null
    };
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
