import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS hubs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY, hub_id TEXT NOT NULL REFERENCES hubs(id),
      digest TEXT NOT NULL, upstream_at TEXT NOT NULL,
      received_at TEXT NOT NULL, saved_at TEXT NOT NULL, stats_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS observed_devices (
      observation_id INTEGER NOT NULL REFERENCES observations(id),
      device_id TEXT NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY (observation_id, device_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS current_observations (
      hub_id TEXT PRIMARY KEY REFERENCES hubs(id),
      observation_id INTEGER NOT NULL REFERENCES observations(id),
      upstream_at TEXT NOT NULL, received_at TEXT NOT NULL, saved_at TEXT NOT NULL
    ) STRICT;
  `);
  const register = db.prepare('INSERT INTO hubs(id,url) VALUES(?,?) ON CONFLICT(id) DO NOTHING');
  const hubUrl = db.prepare('SELECT url FROM hubs WHERE id=?');
  const insert = db.prepare('INSERT INTO observations(hub_id,digest,upstream_at,received_at,saved_at,stats_json) VALUES(?,?,?,?,?,?)');
  const deviceInsert = db.prepare('INSERT INTO observed_devices(observation_id,device_id,data_json) VALUES(?,?,?)');
  const current = db.prepare(`SELECT o.id,o.digest,o.stats_json,c.upstream_at,c.received_at,c.saved_at
    FROM current_observations c JOIN observations o ON o.id=c.observation_id WHERE c.hub_id=?`);
  const devices = db.prepare('SELECT data_json FROM observed_devices WHERE observation_id=? ORDER BY device_id');
  const setCurrent = db.prepare(`INSERT INTO current_observations VALUES(?,?,?,?,?)
    ON CONFLICT(hub_id) DO UPDATE SET observation_id=excluded.observation_id,
      upstream_at=excluded.upstream_at,received_at=excluded.received_at,saved_at=excluded.saved_at`);

  return {
    db,
    registerHub({ id, url }) {
      const existing = hubUrl.get(id);
      if (existing && existing.url !== url) throw new Error('HUB_ID は別の接続先で使用済みです。新しい Hub には別の HUB_ID を指定してください。');
      register.run(id, url);
    },
    readSnapshot(hubId) {
      const row = current.get(hubId);
      if (!row) return null;
      const stats = JSON.parse(row.stats_json);
      stats.devices = devices.all(row.id).map(device => JSON.parse(device.data_json));
      return { id: row.id, upstreamAt: row.upstream_at, receivedAt: row.received_at, savedAt: row.saved_at, stats };
    },
    saveSnapshot(hubId, { upstreamAt, stats }, receivedAt) {
      const { devices: deviceData, ...summary } = stats;
      // Hub response-generation time is not a new usage observation. Identical
      // retries advance receipt metadata without appending another observation.
      const { updatedAt: ignored, ...identity } = stats;
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const savedAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = current.get(hubId);
        let id = previous?.id;
        if (previous?.digest !== digest) {
          id = Number(insert.run(hubId, digest, upstreamAt, receivedAt, savedAt, JSON.stringify(summary)).lastInsertRowid);
          for (const device of deviceData) deviceInsert.run(id, device.deviceId, JSON.stringify(device));
        }
        setCurrent.run(hubId, id, upstreamAt, receivedAt, savedAt);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return this.readSnapshot(hubId);
    },
    close() { db.close(); }
  };
}
