import {DatabaseSync, backup} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// The application uses the native synchronous DatabaseSync/StatementSync API directly.
// Callers serialize writers and use transaction() for short BEGIN IMMEDIATE sections.
export function openDatabase(filename, {demo=false}={}) {
 if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true,mode:0o700});
 const db=new DatabaseSync(filename);
 try {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('BEGIN IMMEDIATE');
  try {
   db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
   const directory=new URL('../migrations/',import.meta.url);
   const names=fs.readdirSync(directory).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
   const existing=db.prepare('SELECT name,checksum FROM schema_migrations').all();
   if (existing.some(row=>!names.includes(row.name))) throw new Error('Database schema is newer than this application');
   for (const name of names) {
    const text=fs.readFileSync(new URL(name,directory),'utf8'),checksum=createHash('sha256').update(text).digest('hex');
    const applied=existing.find(x=>x.name===name);
    if (applied && applied.checksum !== checksum) throw new Error('Applied migration has changed; do not edit old migrations');
    if (!applied) {db.exec(text);db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(name,checksum);}
   }
   const mode=demo?'demo':'real',old=db.prepare("SELECT value FROM app_metadata WHERE key='dataset_mode'").get();
   if (old && old.value!==mode) throw new Error('Demo/real database mixing is prohibited; use separate databasePath');
   if (!old) db.prepare('INSERT INTO app_metadata VALUES (?,?)').run('dataset_mode',mode);
   db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
 } catch(error) {db.close();throw error;}
 return db;
}

const transactions=new WeakSet();
const asyncFunctionPrototype=Object.getPrototypeOf(async function(){});
const isAsyncFunction=value=>typeof value==='function'&&Object.getPrototypeOf(value)===asyncFunctionPrototype;
const isThenable=value=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof value.then==='function';

/** Run a short, synchronous SQLite transaction. Network and file I/O stay outside it. */
export function transaction(db, callback) {
 if(transactions.has(db))throw new Error('Nested/concurrent transaction; serialize callers');
 if(isAsyncFunction(callback))throw new TypeError('transaction callback must be synchronous');
 db.exec('BEGIN IMMEDIATE');transactions.add(db);
 try {
  const result=callback();
  if(isThenable(result)) {
   Promise.resolve(result).catch(()=>{});
   throw new TypeError('transaction callback must be synchronous');
  }
  db.exec('COMMIT');
  return result;
 } catch(error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
 } finally {
  transactions.delete(db);
 }
}
export async function backupDatabase(source,destination){
 if(!fs.existsSync(source))throw new Error('Source database does not exist');
 if(path.resolve(source)===path.resolve(destination))throw new Error('Backup must use a different path');
 fs.mkdirSync(path.dirname(path.resolve(destination)),{recursive:true,mode:0o700});
 // Reserve a new destination without overwriting an existing backup.
 const fd=fs.openSync(destination,'wx',0o600);fs.closeSync(fd);
 let db;
 try{db=new DatabaseSync(source,{readOnly:true});await backup(db,destination);}
 catch(error){fs.rmSync(destination,{force:true});throw error;}
 finally{db?.close();}
}
