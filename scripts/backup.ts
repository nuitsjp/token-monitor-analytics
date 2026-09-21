import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const source = resolve(process.env.DB_PATH ?? './data/app.sqlite');
const destination = process.argv[2];
if (!destination)
    throw new Error('保存先を指定してください: npm run db:backup -- <新規のバックアップファイル>');
const target = resolve(destination);
if (existsSync(target) || target === source)
    throw new Error('バックアップ先は未作成の別ファイルにしてください。');
mkdirSync(dirname(target), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
    db.exec('PRAGMA busy_timeout=2000');
    db.prepare('VACUUM INTO ?').run(target);
    console.log('整合したバックアップを作成しました。');
}
finally {
    db.close();
}
