import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
const db = new DatabaseSync(resolve(process.argv[2] ?? process.env.DB_PATH ?? './data/app.sqlite'), { readOnly: true });
try {
    const result = db.prepare('PRAGMA quick_check').all();
    const version = db.prepare('PRAGMA user_version').get();
    console.log({ version, result });
    if (result.some(r => r.quick_check !== 'ok'))
        process.exitCode = 1;
}
finally {
    db.close();
}
