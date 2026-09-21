import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function openDatabase(path: string): DatabaseSync {
    if (path === ':memory:')
        throw new Error('このアプリはファイルDBを使用します。テストも専用ファイルを指定してください。');
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    const db = new DatabaseSync(absolute);
    try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        assertSupportedSchema(db);
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function assertSupportedSchema(db: DatabaseSync): void {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version === 1)
        return;
    if (version !== 0)
        throw new Error('未対応のDBスキーマです。');
    db.exec('BEGIN IMMEDIATE;');
    try {
        db.exec(`
            CREATE TABLE hubs (
                hub_id TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE hub_states (
                hub_id TEXT NOT NULL PRIMARY KEY REFERENCES hubs(hub_id),
                stats_json TEXT NOT NULL,
                received_at TEXT NOT NULL
            );
            PRAGMA user_version = 1;
        `);
        db.exec('COMMIT;');
    }
    catch (error) {
        try {
            db.exec('ROLLBACK;');
        }
        catch {
            // Preserve the migration error if rollback itself fails.
        }
        throw error;
    }
}
