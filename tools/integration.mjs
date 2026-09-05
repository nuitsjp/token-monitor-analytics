// Real native HTTP/SSE/SQLite integration. Requires Go and Node.js, no npm packages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../analytics/runtime/server.mjs';
import {backupDatabase} from '../analytics/runtime/sqlite.mjs';
import {DatabaseSync} from 'node:sqlite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tma-integration-'));
const children=[];
let app, liveReader;
const token='integration-ingest-000000000000000000000000000';
const env={...process.env,CGO_ENABLED:'0',TMA_INGEST_TOKEN:token,TMA_HUB_A_SECRET:'demo-hub-secret',TMA_HUB_B_SECRET:'demo-hub-secret'};
const suffix=process.platform==='win32'?'.exe':'';
async function freePort(){
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function until(predicate,label,timeout=20000){
 const end=Date.now()+timeout;
 while(Date.now()<end){try{const v=await predicate();if(v)return v;}catch{}await delay(150);}
 throw new Error(`Timed out: ${label}`);
}
function child(file,args){
 const p=spawn(file,args,{env,stdio:['ignore','pipe','pipe']});children.push(p);
 p.on('error',error=>console.error(error.message));
 p.stdout.resume();p.stderr.resume();
 return p;
}
async function stop(p){
 if(p.exitCode!==null||p.signalCode!==null)return;
 const ended=new Promise(resolve=>p.once('exit',resolve));p.kill('SIGTERM');
 const timer=setTimeout(()=>p.kill('SIGKILL'),3000);timer.unref();await ended;clearTimeout(timer);
}
async function frame(reader,contains){
 let text='';const decoder=new TextDecoder();
 const deadline=setTimeout(()=>reader.cancel(),10000);
 try{while(!text.includes(contains)){const r=await reader.read();if(r.done)throw new Error('SSE ended');text+=decoder.decode(r.value,{stream:true});}return text;}
 finally{clearTimeout(deadline);}
}
try{
 const mock=path.join(temp,'mockhub'+suffix),collector=path.join(temp,'collector'+suffix);
 execFileSync('go',['build','-o',mock,'./cmd/mockhub'],{cwd:path.join(root,'collector'),env,stdio:'inherit'});
 execFileSync('go',['build','-o',collector,'./cmd/collector'],{cwd:path.join(root,'collector'),env,stdio:'inherit'});
 const portA=await freePort(),portB=await freePort();
 const mocks=[child(mock,['-listen',`127.0.0.1:${portA}`]),child(mock,['-listen',`127.0.0.1:${portB}`])];
 for(const port of [portA,portB])await until(async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/health`);return r.ok;},'mock health');
 const config=JSON.parse(fs.readFileSync(path.join(root,'analytics/configs/demo.json'),'utf8'));
 config.listen.port=0;config.databasePath=path.join(temp,'analytics.db');
 app=await startServer(config,{env,logger:{info(){},error:console.error}});
 config.listen.port=app.server.address().port;config.publicOrigin=`http://127.0.0.1:${config.listen.port}`;
 const origin=config.publicOrigin;
 const spool=path.join(temp,'outbox');
 const c=JSON.parse(fs.readFileSync(path.join(root,'collector/configs/collector.demo.json'),'utf8'));
 c.analytics_url=origin;c.spool_dir=spool;c.flush_seconds=1;
 c.hubs=[{id:'hub-a',url:`http://127.0.0.1:${portA}`,secret_env:'TMA_HUB_A_SECRET'},{id:'hub-b',url:`http://127.0.0.1:${portB}`,secret_env:'TMA_HUB_B_SECRET'}];
 const file=path.join(temp,'collector.json');fs.writeFileSync(file,JSON.stringify(c));
 const source=await fetch(origin+'/api/live');liveReader=source.body.getReader();await frame(liveReader,'event: ready');
 const bridge=child(collector,['-config',file]);
 const state=()=>fetch(origin+'/api/state').then(r=>r.json());
 await frame(liveReader,'event: updated');
 await until(async()=>{const s=await state();return s.hubs.length===2&&s.estimates.some(e=>e.windowCapacityUsd===160);},'two hubs and real estimate');
 console.log('PASS: two mock Hubs -> Go Collector -> native Analytics -> SQLite -> actual SSE');
 const first=(await state()).hubs[0];const before=app.db.sql.prepare('SELECT count(*) n FROM observations').get().n;
 await liveReader.cancel();liveReader=null;await app.close();app=null;
 await until(()=>fs.readdirSync(spool).filter(n=>n.endsWith('.json')).length>=2,'outbox fills while Analytics is stopped');
 app=await startServer(config,{env,logger:{info(){},error:console.error}});
 assert.ok(app.db.sql.prepare('SELECT count(*) n FROM observations').get().n>=before);
 await until(()=>app.db.sql.prepare('SELECT count(*) n FROM observations').get().n>before,'retry stored after Analytics restart');
 await until(()=>fs.readdirSync(spool).filter(n=>n.endsWith('.json')).length===0,'outbox drains');
 console.log('PASS: Analytics restart preserves history; Collector retries and drains its outbox');
 const replay=await fetch(origin+'/api/ingest',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,events:[first]})});
 assert.equal(replay.status,200);assert.equal(app.db.sql.prepare('SELECT count(*) n FROM observations WHERE hub_id=? AND event_id=?').get(first.hubId,first.eventId).n,1);
 await stop(bridge);
 const bridge2=child(collector,['-config',file]);
 await until(async()=>{const s=await state();return s.hubs.find(h=>h.hubId===first.hubId)?.streamId!==first.streamId;},'Collector reconnect');
 console.log('PASS: replay is idempotent and Collector restart creates a new SSE observation segment');
 await stop(bridge2);for(const p of mocks)await stop(p);
 const backupFile=path.join(temp,'backup.db');await backupDatabase(config.databasePath,backupFile);
 const backup=new DatabaseSync(backupFile,{readOnly:true});assert.ok(backup.prepare('SELECT count(*) n FROM observations').get().n>=before);backup.close();
 console.log('PASS: live SQLite backup and integrity checks');
 assert.equal(app.db.sql.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 console.log('INTEGRATION OK');
}finally{
 if(liveReader)await liveReader.cancel().catch(()=>{});
 for(const p of children)await stop(p);
 if(app)await app.close();
 fs.rmSync(temp,{recursive:true,force:true});
}
