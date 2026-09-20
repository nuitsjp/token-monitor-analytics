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
    if (version !== 0)
        throw new Error('未対応のDBスキーマです。');
}
