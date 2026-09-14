import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { advanceEstimation, interruptEstimation, replayEstimation, seedEstimation } from './estimation.js';
import { contractId, contractScope, contractAccountKey, deviceKey } from './identity.js';
import { buildMetrics } from './metrics.js';

const SCHEMA_VERSION = 10;
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
  ],
  estimation_inputs: [
    ['id', 'INTEGER', 0, 1],
    ['input_json', 'TEXT', 1, 0]
  ],
  estimation_runtime: [
    ['id', 'INTEGER', 0, 1],
    ['interrupted', 'INTEGER', 1, 0]
  ],
  daily_usage: [
    ['hub_id', 'TEXT', 1, 1],
    ['device_id', 'TEXT', 1, 2],
    ['local_date', 'TEXT', 1, 3],
    ['tool', 'TEXT', 1, 4],
    ['tokens', 'REAL', 1, 0],
    ['cost', 'REAL', 1, 0],
    ['record_json', 'TEXT', 1, 0]
  ],
  monthly_usage: [
    ['hub_id', 'TEXT', 1, 1],
    ['device_id', 'TEXT', 1, 2],
    ['month', 'TEXT', 1, 3],
    ['tool', 'TEXT', 1, 4],
    ['tokens', 'REAL', 1, 0],
    ['cost', 'REAL', 1, 0],
    ['record_json', 'TEXT', 1, 0]
  ],
  history_fetch_state: [
    ['hub_id', 'TEXT', 1, 1],
    ['last_success_at', 'TEXT', 0, 0],
    ['last_attempt_at', 'TEXT', 0, 0],
    ['devices_json', 'TEXT', 1, 0]
  ]
});

// Schema 9 already contains the history tables, but predates the persisted
// device date judgment. Keep its shape for pre-migration validation.
const SCHEMA9_COLUMNS = Object.freeze({
  ...SCHEMA_COLUMNS,
  history_fetch_state: [
    ['hub_id', 'TEXT', 1, 1],
    ['last_success_at', 'TEXT', 0, 0],
    ['last_attempt_at', 'TEXT', 0, 0]
  ]
});

const REPLAY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS estimation_inputs (id INTEGER PRIMARY KEY, input_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS estimation_runtime (id INTEGER PRIMARY KEY CHECK (id = 1), interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1))) STRICT;
  INSERT OR IGNORE INTO estimation_runtime VALUES (1, 0);
`;

const V1_SCHEMA_TABLES = Object.freeze(['hubs', 'observations', 'current_devices']);
const V2_SCHEMA_TABLES = Object.freeze([...V1_SCHEMA_TABLES, 'estimation_hubs', 'estimation_events']);
const REPLAY_TABLES = Object.freeze(['estimation_inputs', 'estimation_runtime']);
const HISTORY_TABLES = Object.freeze(['daily_usage', 'monthly_usage', 'history_fetch_state']);
const PRE_REPLAY_SCHEMA_TABLES = Object.freeze(
  Object.keys(SCHEMA_COLUMNS).filter((table) => !REPLAY_TABLES.includes(table) && !HISTORY_TABLES.includes(table))
);
const PRE_HISTORY_SCHEMA_TABLES = Object.freeze(
  Object.keys(SCHEMA_COLUMNS).filter((table) => !HISTORY_TABLES.includes(table))
);
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
  }),
  daily_usage_by_hub_date: Object.freeze({
    table: 'daily_usage', columns: Object.freeze(['hub_id', 'local_date', 'device_id', 'tool']), unique: 0
  }),
  monthly_usage_by_hub_month: Object.freeze({
    table: 'monthly_usage', columns: Object.freeze(['hub_id', 'month', 'device_id', 'tool']), unique: 0
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
  daily_usage: Object.freeze([['hubs', 'hub_id', 'id']]),
  monthly_usage: Object.freeze([['hubs', 'hub_id', 'id']]),
  history_fetch_state: Object.freeze([['hubs', 'hub_id', 'id']]),
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

const HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS daily_usage (
    hub_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    tool TEXT NOT NULL,
    tokens REAL NOT NULL,
    cost REAL NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (hub_id, device_id, local_date, tool),
    FOREIGN KEY (hub_id) REFERENCES hubs(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS daily_usage_by_hub_date
    ON daily_usage (hub_id, local_date, device_id, tool);
  CREATE TABLE IF NOT EXISTS monthly_usage (
    hub_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    month TEXT NOT NULL,
    tool TEXT NOT NULL,
    tokens REAL NOT NULL,
    cost REAL NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (hub_id, device_id, month, tool),
    FOREIGN KEY (hub_id) REFERENCES hubs(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS monthly_usage_by_hub_month
    ON monthly_usage (hub_id, month, device_id, tool);
  CREATE TABLE IF NOT EXISTS history_fetch_state (
    hub_id TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_attempt_at TEXT,
    devices_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (hub_id) REFERENCES hubs(id)
  ) STRICT;
`;

const PRE_REPLAY_SCHEMA_INDEXES = Object.freeze(
  Object.fromEntries(
    Object.entries(SCHEMA_INDEXES).filter(([, index]) => !HISTORY_TABLES.includes(index.table)),
  )
);
const PRE_HISTORY_SCHEMA_INDEXES = Object.freeze(
  Object.fromEntries(
    Object.entries(SCHEMA_INDEXES).filter(([, index]) => !HISTORY_TABLES.includes(index.table)),
  )
);

const SUPPORTED_SCHEMA_VERSIONS = `1〜${SCHEMA_VERSION}`;

// 起動制御が復旧情報をログへ出せるよう、版と段階を持たせる（UC-4）。
function schemaError(version) {
  const error = new Error('database schema is incompatible');
  error.code = 'SCHEMA_INCOMPATIBLE';
  error.schemaVersion = Number.isInteger(version) ? version : null;
  error.supportedVersions = SUPPORTED_SCHEMA_VERSIONS;
  return error;
}

function migrationError(stage, version, cause) {
  const error = new Error(`schema migration failed at ${stage}: ${cause.message}`, { cause });
  error.code = 'MIGRATION_FAILED';
  error.stage = stage;
  error.schemaVersion = version;
  error.targetVersion = SCHEMA_VERSION;
  error.sqliteCode = Number.isInteger(cause.errcode) ? cause.errcode : null;
  return error;
}

function rollbackQuietly(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the error that caused the transaction to fail.
  }
}

function rollbackSavepointQuietly(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
  } catch {
    // Preserve the error that caused the migration step to fail.
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
    ${HISTORY_SCHEMA_SQL}
    ${REPLAY_SCHEMA_SQL}
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

function assertColumns(db, tables, columnsByTable = SCHEMA_COLUMNS) {
  for (const table of tables) {
    const expectedColumns = columnsByTable[table];
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

function assertSchema(db, tables, indexes, columnsByTable = SCHEMA_COLUMNS) {
  assertColumns(db, tables, columnsByTable);
  assertIndexes(db, indexes);
  assertForeignKeys(db, tables);
}

function preserveLastResults(previousGroups, nextGroups) {
  const previousById = new Map(previousGroups.map((group) => [group.id, group]));
  for (const group of nextGroups) {
    const previousResult = previousById.get(group.id)?.view?.lastResult;
    if (previousResult) group.view.lastResult = structuredClone(previousResult);
  }
}

function migrateSchema(db, version) {
  const savepoint = 'migrate_schema';
  db.exec(`SAVEPOINT ${savepoint}`);
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
    db.exec(REPLAY_SCHEMA_SQL);
    assertSchema(db, PRE_HISTORY_SCHEMA_TABLES, PRE_HISTORY_SCHEMA_INDEXES);
    db.exec('PRAGMA user_version = 8');
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    rollbackSavepointQuietly(db, savepoint);
    throw error;
  }
}

function assertCompatibleSchema(db, estimationSettings) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 1 || version === 2) {
    const indexes = { observations_by_device: SCHEMA_INDEXES.observations_by_device };
    if (version === 2) indexes.estimation_events_by_series = SCHEMA_INDEXES.estimation_events_by_series;
    assertSchema(db, version === 1 ? V1_SCHEMA_TABLES : V2_SCHEMA_TABLES, indexes);
  } else {
    if (![3, 4, 5, 6, 7, 8, 9, SCHEMA_VERSION].includes(version)) throw schemaError(version);
    if (version === SCHEMA_VERSION) {
      assertSchema(db, Object.keys(SCHEMA_COLUMNS), SCHEMA_INDEXES);
    } else if (version === 9) {
      assertSchema(db, Object.keys(SCHEMA_COLUMNS), SCHEMA_INDEXES, SCHEMA9_COLUMNS);
    } else if (version === 8) {
      assertSchema(db, PRE_HISTORY_SCHEMA_TABLES, PRE_HISTORY_SCHEMA_INDEXES);
    } else {
      assertSchema(db, PRE_REPLAY_SCHEMA_TABLES, PRE_REPLAY_SCHEMA_INDEXES);
    }
  }
  if (version === SCHEMA_VERSION) return { version, migratedFrom: null };

  let stage = 'begin';
  const run = (name, step) => { stage = name; step(); };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 1 || version === 2) {
      run('schema', () => migrateSchema(db, version));
      run('estimation-checkpoint', () => migrateEstimationCheckpoint(db, estimationSettings, version));
      run('history-tables', () => migrateHistoryTables(db));
    }
    else {
      if (version < 8) {
        if (version === 3) run('grok-contracts', () => migrateGrokContracts(db));
        if (version === 3 || version === 4) run('contract-scopes', () => migrateContractScopes(db));
        if (version < 6) run('usage-policy', () => migrateUsagePolicy(db));
        run('estimation-checkpoint', () => migrateEstimationCheckpoint(db, estimationSettings, version));
      }
      run('history-tables', () => migrateHistoryTables(db));
    }
    run('commit', () => db.exec('COMMIT'));
  } catch (error) {
    rollbackQuietly(db);
    throw migrationError(stage, version, error);
  }
  return { version: SCHEMA_VERSION, migratedFrom: version };
}

function migrateHistoryTables(db) {
  const savepoint = 'migrate_history_tables';
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    db.exec(HISTORY_SCHEMA_SQL);
    const historyColumns = db.prepare('PRAGMA table_info(history_fetch_state)').all();
    if (!historyColumns.some((column) => column.name === 'devices_json')) {
      db.exec("ALTER TABLE history_fetch_state ADD COLUMN devices_json TEXT NOT NULL DEFAULT '[]'");
    }
    assertSchema(db, Object.keys(SCHEMA_COLUMNS), SCHEMA_INDEXES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    rollbackSavepointQuietly(db, savepoint);
    throw error;
  }
}

function migrateGrokContracts(db) {
  const savepoint = 'migrate_grok_contracts';
  db.exec(`SAVEPOINT ${savepoint}`);
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
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    rollbackSavepointQuietly(db, savepoint);
    throw error;
  }
}

function migrateContractScopes(db) {
  const savepoint = 'migrate_contract_scopes';
  db.exec(`SAVEPOINT ${savepoint}`);
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
      const replacements = seeded.groups.filter((group) => changedTools.has(group.view.tool));
      preserveLastResults(state.groups, replacements);
      state.groups = [...state.groups.filter((group) => !changedTools.has(group.view.tool)), ...replacements];
      db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
    }
    db.exec('PRAGMA user_version = 5');
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    rollbackSavepointQuietly(db, savepoint);
    throw error;
  }
}

function migrateUsagePolicy(db) {
  const savepoint = 'migrate_usage_policy';
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const checkpoint = db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
    if (checkpoint) {
      const old = parseStoredJson(checkpoint.state_json);
      const seeded = seedEstimation({ devices: readDevices(db), registry: readRegistry(db), receivedAt: new Date().toISOString() }).state;
      const freshIds = new Set(seeded.groups.map(group => group.id));
      preserveLastResults(old.groups, seeded.groups);
      const archived = old.groups.filter(group => !freshIds.has(group.id)).map(group => ({
        ...group, baseline: null, latest: null,
        view: { ...group.view, active: false, reason: 'method_changed', message: '集計方法の変更前の記録です。現在の推定には使いません。' },
      }));
      seeded.groups.push(...archived);
      db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(seeded));
    }
    db.exec('PRAGMA user_version = 6');
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    rollbackSavepointQuietly(db, savepoint);
    throw error;
  }
}

function migrateEstimationCheckpoint(db, settings, sourceVersion) {
  db.exec(REPLAY_SCHEMA_SQL);
  const checkpoint = db.prepare('SELECT state_json FROM shared_estimation_state WHERE id = 1').get();
  if (checkpoint) {
    let state = parseStoredJson(checkpoint.state_json);
    // Schema 7 replay invented freshness and notification boundaries. Its
    // results remain visible as previous results, but its baseline is unsafe.
    if (sourceVersion === 7) {
      state = interruptEstimation(state, { reason: 'incomplete_replay_history' }).state;
    }
    db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(state));
    if (!db.prepare('SELECT 1 FROM estimation_inputs LIMIT 1').get()) {
      appendEstimationInput(db, { kind: 'checkpoint', state });
    }
  }
  db.exec('PRAGMA user_version = 8');
}

function appendEstimationInput(db, input) {
  db.prepare('INSERT INTO estimation_inputs (input_json) VALUES (?)').run(JSON.stringify(input));
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

const HISTORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_MONTH_PATTERN = /^\d{4}-\d{2}$/;
const HISTORY_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const HISTORY_KINDS = Object.freeze(['daily', 'monthly']);

function validHistoryDate(value) {
  if (typeof value !== 'string' || !HISTORY_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(0, 0, 0, 0);
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

function validHistoryMonth(value) {
  if (typeof value !== 'string' || !HISTORY_MONTH_PATTERN.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function validHistoryPeriod(value, kind) {
  return kind === 'daily' ? validHistoryDate(value) : validHistoryMonth(value);
}

function encodeHistoryCursor(row, kind) {
  return Buffer.from(JSON.stringify({
    kind,
    period: row.periodKey,
    hubId: row.hubId,
    deviceId: row.deviceId,
    tool: row.tool,
  }), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value, kind) {
  if (typeof value !== 'string' || value.length === 0 || !HISTORY_CURSOR_PATTERN.test(value)) {
    throw new TypeError('history before cursor must be a base64url string');
  }

  let cursor;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 0 || bytes.toString('base64url') !== value) throw new Error('non-canonical cursor');
    cursor = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError('history before cursor is invalid');
  }

  if (!isPlainObject(cursor)
    || Object.keys(cursor).length !== 5
    || cursor.kind !== kind
    || typeof cursor.period !== 'string'
    || !validHistoryPeriod(cursor.period, kind)
    || typeof cursor.hubId !== 'string'
    || cursor.hubId.length === 0
    || typeof cursor.deviceId !== 'string'
    || cursor.deviceId.length === 0
    || typeof cursor.tool !== 'string'
    || cursor.tool.length === 0) {
    throw new TypeError('history before cursor is invalid');
  }
  return cursor;
}

// Validate the public history query at the HTTP/store boundary. The before
// cursor remains opaque to callers, while its kind and complete sort key are
// checked here so a page cannot silently mix daily and monthly rows.
export function validateHistoryQuery(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('history query must be an object');
  const kind = options.kind === undefined ? 'daily' : options.kind;
  if (!HISTORY_KINDS.includes(kind)) throw new TypeError('invalid history kind');

  const from = options.from;
  const to = options.to;
  if (from !== undefined && !validHistoryPeriod(from, kind)) {
    throw new TypeError('history from date is invalid');
  }
  if (to !== undefined && !validHistoryPeriod(to, kind)) {
    throw new TypeError('history to date is invalid');
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new TypeError('history from must be before or equal to to');
  }

  const limit = options.limit === undefined ? 100 : options.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError('history limit must be an integer between 1 and 500');
  }

  const before = options.before;
  if (before !== undefined) decodeHistoryCursor(before, kind);

  return { kind, hubId: options.hubId, deviceId: options.deviceId, tool: options.tool,
    from, to, limit, before };
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

function readHistoryMetadata(value) {
  const record = parseStoredJson(value);
  return {
    todayKey: typeof record?.todayKey === 'string' ? record.todayKey : null,
    timeZone: typeof record?.timeZone === 'string' ? record.timeZone : null,
    fetchedAt: typeof record?.fetchedAt === 'string' ? record.fetchedAt : null,
  };
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
  #schema;

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
      if (isNew) { createSchema(db); this.#schema = { version: SCHEMA_VERSION, migratedFrom: null }; }
      else this.#schema = assertCompatibleSchema(db, estimationSettings);
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
    const last = db.prepare('SELECT input_json FROM estimation_inputs ORDER BY id DESC LIMIT 1').get();
    this.#hubGaps = new Map(last ? parseStoredJson(last.input_json).hubGaps ?? [] : []);
  }

  // 起動時に確認したスキーマ版と、この起動で移行した元の版（移行なしは null）。
  get schema() { return { ...this.#schema }; }

  beginCollection(at) {
    if (this.#db.prepare('SELECT interrupted FROM estimation_runtime WHERE id = 1').get().interrupted) {
      for (const { id } of this.#db.prepare('SELECT id FROM hubs').all()) this.markEstimationGap(id, 'recovery', at);
    }
    this.#db.prepare('UPDATE estimation_runtime SET interrupted = 1 WHERE id = 1').run();
  }

  finishCollection() {
    this.#db.prepare('UPDATE estimation_runtime SET interrupted = 0 WHERE id = 1').run();
  }

  rebuildEstimation() {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const select = this.#db.prepare('SELECT observation_json FROM observations WHERE id = ?');
      // Only retain currently referenced observations, not the full history.
      let cache = new Map();
      const rows = this.#db.prepare('SELECT input_json FROM estimation_inputs ORDER BY id').iterate();
      function* inputs() {
        for (const row of rows) {
          const input = parseStoredJson(row.input_json);
          if (input.kind === 'notification') {
            cache = new Map(input.devices.map(({ observationId }) => [observationId,
              cache.get(observationId) ?? parseStoredJson(select.get(observationId).observation_json)]));
          }
          yield input;
        }
      }
      const result = replayEstimation({ inputs: inputs(), readObservation: (id) => cache.get(id) });
      if (result.state) this.#db.prepare('UPDATE shared_estimation_state SET state_json = ? WHERE id = 1').run(JSON.stringify(result.state));
      this.#db.exec('COMMIT');
      return result.state;
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
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
      const registry = readRegistry(this.#db);
      const estimationResult = advanceEstimation(
        previousState,
        { devices: estimationDevices, registry, receivedAt: analyticsReceivedAt },
        this.#estimationSettings
      );
      persistEstimation(
        estimationResult,
        estimation.upsert,
        estimation.insert
      );

      appendEstimationInput(this.#db, {
        kind: 'notification', hubId, receivedAt: analyticsReceivedAt, registry,
        settings: this.#estimationSettings,
        devices: estimationDevices.map(({ observation, metadata, ...device }) => ({
          ...device, metadata: { stale: metadata.stale === true },
        })),
        hubGaps: [...this.#hubGaps].filter(([id]) => id !== hubId),
      });
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
    if (this.#hubGaps.get(hubId) === reason) return;

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
      appendEstimationInput(this.#db, {
        kind: 'gap', hubId, reason, at,
        hubGaps: [...new Map([...this.#hubGaps, [hubId, reason]])],
      });
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

  setCollectionEnabled(hubId, enabled) {
    if (typeof hubId !== 'string' || hubId.length === 0) {
      throw new TypeError('hub id must be a non-empty string');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare(
        'UPDATE hubs SET collection_enabled = ? WHERE id = ?',
      ).run(enabled ? 1 : 0, hubId);
      if (result.changes !== 1) throw new Error('hub is not registered');
      this.#db.exec('COMMIT');
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  // U6: 日次・月次実績の確定点。履歴行と取得完了状態を同一トランザクションで
  // コミットする。成功をもって取得成功とし、保存失敗は成功扱いにしない（S2）。
  // Hub側応答にない過去レコードは削除せず、再取得データで非破壊更新する。
  commitHistory(hubId, { daily = [], monthly = [], devices = [] } = {}, fetchedAt) {
    if (typeof hubId !== 'string' || hubId.length === 0) {
      throw new TypeError('hub id must be a non-empty string');
    }
    if (!Array.isArray(daily) || !Array.isArray(monthly) || !Array.isArray(devices)) {
      throw new TypeError('history records must be arrays');
    }
    validateReceivedAt(fetchedAt);
    for (const record of [...daily, ...monthly]) {
      if (!record || typeof record !== 'object') throw new TypeError('history record is invalid');
      if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) {
        throw new TypeError('history device id must be a non-empty string');
      }
      if (typeof record.tool !== 'string' || record.tool.length === 0) {
        throw new TypeError('history tool must be a non-empty string');
      }
      if (typeof record.tokens !== 'number' || !Number.isFinite(record.tokens) || record.tokens < 0) {
        throw new TypeError('history tokens must be a finite non-negative number');
      }
      if (typeof record.cost !== 'number' || !Number.isFinite(record.cost) || record.cost < 0) {
        throw new TypeError('history cost must be a finite non-negative number');
      }
      for (const [name, value] of [['todayKey', record.todayKey], ['timeZone', record.timeZone], ['fetchedAt', record.fetchedAt]]) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          throw new TypeError(`history ${name} must be a string or null`);
        }
      }
    }
    const savedDevices = devices.map((device) => {
      if (!isPlainObject(device) || typeof device.deviceId !== 'string' || device.deviceId.length === 0) {
        throw new TypeError('history device state is invalid');
      }
      const todayKey = device.todayKey === undefined ? null : device.todayKey;
      const timeZone = device.timeZone === undefined ? null : device.timeZone;
      const dailyStatus = device.dailyStatus;
      if ((todayKey !== null && typeof todayKey !== 'string')
        || (timeZone !== null && typeof timeZone !== 'string')
        || !['available', 'no_previous_day', 'unknown_today'].includes(dailyStatus)) {
        throw new TypeError('history device state is invalid');
      }
      return { deviceId: device.deviceId, todayKey, timeZone, dailyStatus };
    });
    const recordJson = (record) => JSON.stringify({
      tokens: record.tokens,
      cost: record.cost,
      todayKey: record.todayKey ?? null,
      timeZone: record.timeZone ?? null,
      fetchedAt: record.fetchedAt ?? null,
    });
    const upsertDeviceState = this.#db.prepare(`
      INSERT INTO history_fetch_state (hub_id, last_success_at, last_attempt_at, devices_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (hub_id) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        devices_json = excluded.devices_json
    `);
    const upsertDeviceStateJson = JSON.stringify(savedDevices);
    const upsertDaily = this.#db.prepare(`
      INSERT INTO daily_usage (hub_id, device_id, local_date, tool, tokens, cost, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (hub_id, device_id, local_date, tool) DO UPDATE SET
        tokens = excluded.tokens,
        cost = excluded.cost,
        record_json = excluded.record_json
    `);
    const upsertMonthly = this.#db.prepare(`
      INSERT INTO monthly_usage (hub_id, device_id, month, tool, tokens, cost, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (hub_id, device_id, month, tool) DO UPDATE SET
        tokens = excluded.tokens,
        cost = excluded.cost,
        record_json = excluded.record_json
    `);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (this.#db.prepare('SELECT 1 AS present FROM hubs WHERE id = ?').get(hubId) === undefined) {
        throw new Error('hub is not registered');
      }
      for (const record of daily) {
        if (typeof record.date !== 'string') throw new TypeError('daily record date is invalid');
        upsertDaily.run(hubId, record.deviceId, record.date, record.tool, record.tokens, record.cost,
          recordJson(record));
      }
      for (const record of monthly) {
        if (typeof record.month !== 'string') throw new TypeError('monthly record month is invalid');
        upsertMonthly.run(hubId, record.deviceId, record.month, record.tool, record.tokens, record.cost,
          recordJson(record));
      }
      upsertDeviceState.run(hubId, fetchedAt, fetchedAt, upsertDeviceStateJson);
      this.#db.exec('COMMIT');
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  readHistoryFetchState(hubId) {
    if (hubId !== undefined && (typeof hubId !== 'string' || hubId.length === 0)) {
      throw new TypeError('hub id must be a non-empty string');
    }
    if (hubId) {
      const row = this.#db.prepare(
        'SELECT hub_id AS hubId, last_success_at AS lastSuccessAt, last_attempt_at AS lastAttemptAt, devices_json AS devicesJson FROM history_fetch_state WHERE hub_id = ?',
      ).get(hubId);
      return row ? {
        hubId: row.hubId, lastSuccessAt: row.lastSuccessAt, lastAttemptAt: row.lastAttemptAt,
        devices: parseStoredJson(row.devicesJson),
      } : null;
    }
    return this.#db.prepare(
      'SELECT hub_id AS hubId, last_success_at AS lastSuccessAt, last_attempt_at AS lastAttemptAt, devices_json AS devicesJson FROM history_fetch_state ORDER BY hub_id',
    ).all().map((row) => ({
      hubId: row.hubId, lastSuccessAt: row.lastSuccessAt, lastAttemptAt: row.lastAttemptAt,
      devices: parseStoredJson(row.devicesJson),
    }));
  }

  readHistory(options = {}) {
    const { kind, hubId, deviceId, tool, from, to, limit, before } = validateHistoryQuery(options);
    const cursor = before === undefined ? null : decodeHistoryCursor(before, kind);
    const table = kind === 'daily' ? 'daily_usage' : 'monthly_usage';
    const keyColumn = kind === 'daily' ? 'local_date' : 'month';
    const keyName = kind === 'daily' ? 'date' : 'month';
    const conditions = [];
    const parameters = [];
    if (hubId !== undefined) { conditions.push('hub_id = ?'); parameters.push(hubId); }
    if (deviceId !== undefined) { conditions.push('device_id = ?'); parameters.push(deviceId); }
    if (tool !== undefined) { conditions.push('tool = ?'); parameters.push(tool); }
    if (from !== undefined) { conditions.push(`${keyColumn} >= ?`); parameters.push(from); }
    if (to !== undefined) { conditions.push(`${keyColumn} <= ?`); parameters.push(to); }
    if (cursor) {
      conditions.push(`(
        ${keyColumn} < ?
        OR (${keyColumn} = ? AND hub_id > ?)
        OR (${keyColumn} = ? AND hub_id = ? AND device_id > ?)
        OR (${keyColumn} = ? AND hub_id = ? AND device_id = ? AND tool > ?)
      )`);
      parameters.push(
        cursor.period,
        cursor.period, cursor.hubId,
        cursor.period, cursor.hubId, cursor.deviceId,
        cursor.period, cursor.hubId, cursor.deviceId, cursor.tool,
      );
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.#db.prepare(`
      SELECT hub_id AS hubId, device_id AS deviceId, ${keyColumn} AS periodKey, tool, tokens, cost, record_json AS recordJson
      FROM ${table}
      ${where}
      ORDER BY ${keyColumn} DESC, hub_id, device_id, tool
      LIMIT ?
    `).all(...parameters, limit + 1);
    const hasNext = rows.length > limit;
    return {
      kind,
      items: rows.slice(0, limit).map((row) => ({
        hubId: row.hubId, deviceId: row.deviceId, [keyName]: row.periodKey, tool: row.tool,
        tokens: row.tokens, cost: row.cost, ...readHistoryMetadata(row.recordJson),
      })),
      nextCursor: hasNext ? encodeHistoryCursor(rows[limit - 1], kind) : null,
    };
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
