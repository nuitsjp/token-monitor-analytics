import {DatabaseSync, backup} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Synchronous native statements keep each batch indivisible within the JS event loop.
// The server serializes every DB operation and wraps ingest's reads+writes in transaction().
export function openDatabase(filename, {demo=false}={}) {
 if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true,mode:0o700});
 const sql=new DatabaseSync(filename);
 try {
  sql.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  sql.exec('BEGIN IMMEDIATE');
  try {
   sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
   const directory=new URL('../migrations/',import.meta.url);
   const names=fs.readdirSync(directory).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
   const existing=sql.prepare('SELECT name,checksum FROM schema_migrations').all();
   if (existing.some(row=>!names.includes(row.name))) throw new Error('Database schema is newer than this application');
   for (const name of names) {
    const text=fs.readFileSync(new URL(name,directory),'utf8'),checksum=createHash('sha256').update(text).digest('hex');
    const applied=existing.find(x=>x.name===name);
    if (applied && applied.checksum !== checksum) throw new Error('Applied migration has changed; do not edit old migrations');
    if (!applied) {sql.exec(text);sql.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(name,checksum);}
   }
   const mode=demo?'demo':'real',old=sql.prepare("SELECT value FROM app_metadata WHERE key='dataset_mode'").get();
   if (old && old.value!==mode) throw new Error('Demo/real database mixing is prohibited; use separate databasePath');
   if (!old) sql.prepare('INSERT INTO app_metadata VALUES (?,?)').run('dataset_mode',mode);
   sql.exec('COMMIT');
  } catch(error) {sql.exec('ROLLBACK');throw error;}
 } catch(error) {sql.close();throw error;}
 let inTransaction=false;
 const wrap=(text,args=[])=>({
  bind(...values){return wrap(text,values);},
  async all(){return {results:sql.prepare(text).all(...args),success:true,meta:{}};},
  async first(){return sql.prepare(text).get(...args)??null;},
  async run(){const r=sql.prepare(text).run(...args);return {results:[],success:true,meta:{changes:Number(r.changes)}};},
  execute(){const r=sql.prepare(text).run(...args);return {results:[],success:true,meta:{changes:Number(r.changes)}};}
 });
 const database={
  sql,prepare:wrap,
  async batch(statements){
   const own=!inTransaction;
   if(own)sql.exec('BEGIN IMMEDIATE');
   try{const results=statements.map(s=>s.execute());if(own)sql.exec('COMMIT');return results;}
   catch(error){if(own)sql.exec('ROLLBACK');throw error;}
  },
  async transaction(callback){
   if(inTransaction)throw new Error('Nested/concurrent transaction; serialize callers');
   sql.exec('BEGIN IMMEDIATE');inTransaction=true;
   try{const result=await callback();sql.exec('COMMIT');return result;}
   catch(error){sql.exec('ROLLBACK');throw error;}
   finally{inTransaction=false;}
  },
  close(){sql.close();}
 };
 return database;
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
