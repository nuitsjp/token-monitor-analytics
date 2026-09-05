import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,credentials} from '../runtime/config.mjs';
import {canView,canIngest,allowedRequest} from '../runtime/auth.mjs';
import {openDatabase,backupDatabase} from '../runtime/sqlite.mjs';
import {startServer} from '../runtime/server.mjs';
import {ingest} from '../src/db.ts';
import {contract,observation} from './adapter.mjs';

const token='test-ingest-token-0000000000000000000000000000000';
const env={TMA_INGEST_TOKEN:token,TMA_VIEWER_USER:'viewer',TMA_VIEWER_PASSWORD:'test-viewer-password-0000000000000'};
const logger={info(){},error(){}};
const cleanups=new WeakMap();
function cleanup(t,fn){
 if(!cleanups.has(t)){const list=[];cleanups.set(t,list);t.after(async()=>{for(const action of list.reverse())await action();});}
 cleanups.get(t).push(fn);
}
function configFile(t,changes={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-native-'));cleanup(t,()=>fs.rmSync(dir,{recursive:true,force:true}));
 const raw=JSON.parse(fs.readFileSync(new URL('../configs/demo.json',import.meta.url),'utf8'));
 Object.assign(raw,{demo:false,databasePath:'analytics.db',contracts:[contract]},changes);
 const file=path.join(dir,'settings.json');fs.writeFileSync(file,JSON.stringify(raw));
 return {dir,file,raw,config:()=>loadConfig(file)};
}
async function serverFixture(t,changes={}){
 const f=configFile(t,changes),c=f.config();c.listen.port=0;
 const app=await startServer(c,{env,logger,heartbeatMs:50});
 c.listen.port=app.server.address().port;c.publicOrigin=`http://127.0.0.1:${c.listen.port}`;
 cleanup(t,()=>app.close());
 return {...f,c,app,url:c.publicOrigin,request:(p,init)=>fetch(c.publicOrigin+p,init)};
}
const post=events=>({method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,events})});
async function readFrame(reader,match){
 let all='';const decoder=new TextDecoder();
 for(let n=0;n<30;n++){
  const result=await reader.read();if(result.done)throw new Error('SSE closed prematurely');
  all+=decoder.decode(result.value,{stream:true});if(all.includes(match))return all;
 }
 throw new Error('SSE event not found');
}

test('configuration paths are relative to the config, not working directory',t=>{
 const f=configFile(t);assert.equal(f.config().databasePath,path.join(f.dir,'analytics.db'));
});
test('UTF-8 BOM and spaces in configuration path are supported',t=>{
 const f=configFile(t),file=path.join(f.dir,'settings with space.json');fs.writeFileSync(file,'\ufeff'+JSON.stringify(f.raw));assert.equal(loadConfig(file).hubs.length,2);
});
test('unknown fields and unsafe bind without TLS/basic are rejected',t=>{
 const f=configFile(t);fs.writeFileSync(f.file,JSON.stringify({...f.raw,accidentalSecret:'x'}));assert.throws(f.config);
 fs.writeFileSync(f.file,JSON.stringify({...f.raw,listen:{host:'0.0.0.0',port:8787}}));assert.throws(f.config);
});
test('contracts with empty/duplicate IDs or string booleans are rejected',t=>{
 const f=configFile(t);fs.writeFileSync(f.file,JSON.stringify({...f.raw,contracts:[{...contract,attributionConfirmed:'true'}]}));assert.throws(f.config);
 fs.writeFileSync(f.file,JSON.stringify({...f.raw,hubs:[{id:'a',label:'A'},{id:'a',label:'B'}]}));assert.throws(f.config);
});
test('missing ingest token and reused demo token fail closed',t=>{
 const f=configFile(t);assert.throws(()=>credentials(f.config(),{}));
 assert.throws(()=>credentials(f.config(),{TMA_INGEST_TOKEN:'demo-ingest-token-not-for-production'}));
});
test('basic viewer credentials are independent from ingest',t=>{
 const c=configFile(t,{viewerAuth:{mode:'basic',userEnv:'TMA_VIEWER_USER',passwordEnv:'TMA_VIEWER_PASSWORD'}}).config();
 const auth=credentials(c,env),request={headers:{authorization:'Basic '+Buffer.from('viewer:'+env.TMA_VIEWER_PASSWORD).toString('base64')},socket:{remoteAddress:'127.0.0.1'}};
 assert.ok(canView(request,c,auth));assert.equal(canIngest(request,auth),false);
 assert.throws(()=>credentials(c,{...env,TMA_VIEWER_PASSWORD:token}));
});
test('native SQLite migration is idempotent across reopen',t=>{
 const c=configFile(t).config();let db=openDatabase(c.databasePath);assert.equal(db.sql.prepare('SELECT count(*) n FROM schema_migrations').get().n,1);db.close();
 db=openDatabase(c.databasePath);assert.equal(db.sql.prepare('PRAGMA journal_mode').get().journal_mode,'wal');db.close();
});
test('demo database cannot be reused for real observations',t=>{
 const c=configFile(t).config();const db=openDatabase(c.databasePath,{demo:true});db.close();assert.throws(()=>openDatabase(c.databasePath,{demo:false}),/mixing/);
});
test('entire ingest transaction rolls back on a storage failure',async t=>{
 const c=configFile(t).config(),db=openDatabase(c.databasePath);cleanup(t,()=>db.close());
 db.sql.exec("CREATE TRIGGER fail_daily BEFORE INSERT ON daily_estimates BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
 await assert.rejects(db.transaction(()=>ingest(db,{events:[observation()]},[contract],'Asia/Tokyo')));
 assert.equal(db.sql.prepare('SELECT count(*) n FROM observations').get().n,0);
 assert.equal(db.sql.prepare('SELECT count(*) n FROM hub_latest').get().n,0);
});
test('backup includes committed WAL data while the source remains open',async t=>{
 const f=configFile(t),db=openDatabase(f.config().databasePath);cleanup(t,()=>db.close());
 await db.transaction(()=>ingest(db,{events:[observation(),observation(1)]},[contract],'Asia/Tokyo'));
 const output=path.join(f.dir,'backup.db');await backupDatabase(f.config().databasePath,output);
 const copy=new DatabaseSync(output,{readOnly:true});assert.equal(copy.prepare('SELECT count(*) n FROM observations').get().n,2);copy.close();
 await assert.rejects(backupDatabase(f.config().databasePath,output));
});
test('HTTP serves existing UI and enforces ingest authentication',async t=>{
 const f=await serverFixture(t);
 assert.equal((await f.request('/')).status,200);
 assert.equal((await f.request('/api/health')).status,200);
 assert.equal((await f.request('/api/ingest',{...post([observation()]),headers:{Authorization:'Bearer wrong','Content-Type':'application/json'}})).status,401);
 const response=await f.request('/api/ingest',post([observation(),observation(1)]));assert.equal(response.status,200);assert.equal((await response.json()).acked.length,2);
 const state=await (await f.request('/api/state')).json();assert.equal(state.storage,'sqlite');assert.equal(state.estimates[0].windowCapacityUsd,160);assert.equal(JSON.stringify(state).includes(token),false);
 assert.ok((await (await f.request('/styles.css')).text()).length>100);
});
test('concurrent requests are serialized without losing latest state or duplicating events',async t=>{
 const f=await serverFixture(t);
 const responses=await Promise.all([0,1,2,3,4,4].map(n=>f.request('/api/ingest',post([observation(n)]))));
 assert.ok(responses.every(r=>r.status===200));assert.equal(f.app.db.sql.prepare('SELECT count(*) n FROM observations').get().n,5);
 const state=await (await f.request('/api/state')).json();assert.equal(state.hubs[0].eventId,observation(4).eventId);
});
test('schema errors, unknown hubs, wrong methods, body sizes are rejected',async t=>{
 const f=await serverFixture(t);assert.equal((await f.request('/api/ingest')).status,405);
 assert.equal((await f.request('/api/ingest',post([{...observation(),hubId:'unknown'}]))).status,400);
 assert.equal((await f.request('/api/ingest',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await f.request('/api/ingest',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'x'.repeat(270001)})).status,413);
 assert.equal((await f.request('/api/history?contract=unknown')).status,404);
});
test('Host allowlist and cross-origin requests fail closed',async t=>{
 const f=await serverFixture(t);
 const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(f.url+'/api/state',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
 assert.equal(hostStatus,403);
 assert.equal((await f.request('/api/state',{headers:{Origin:'https://attacker.invalid'}})).status,403);
 assert.equal(allowedRequest({headers:{host:'attacker.invalid'},socket:{remoteAddress:'127.0.0.1'}},f.c),false);
});
test('basic auth protects HTML, state and SSE but not the separate ingest token',async t=>{
 const f=await serverFixture(t,{viewerAuth:{mode:'basic',userEnv:'TMA_VIEWER_USER',passwordEnv:'TMA_VIEWER_PASSWORD'}});
 for(const route of ['/','/app.js','/api/state','/api/live'])assert.equal((await f.request(route)).status,401);
 const auth='Basic '+Buffer.from(`viewer:${env.TMA_VIEWER_PASSWORD}`).toString('base64');
 assert.equal((await f.request('/api/state',{headers:{Authorization:auth}})).status,200);
 assert.equal((await f.request('/api/ingest',post([observation()]))).status,200);
});
test('actual SSE sends ready, update, heartbeat and supports reconnect snapshot reads', {timeout:10000},async t=>{
 const f=await serverFixture(t),controller=new AbortController();cleanup(t,()=>controller.abort());
 const stream=await f.request('/api/live',{signal:controller.signal});assert.match(stream.headers.get('content-type'),/^text\/event-stream/);
 const reader=stream.body.getReader();await readFrame(reader,'event: ready');
 assert.equal((await f.request('/api/ingest',post([observation()]))).status,200);
 await readFrame(reader,'event: updated');await readFrame(reader,': heartbeat');await reader.cancel();
 const again=await f.request('/api/live',{signal:controller.signal}),second=again.body.getReader();await readFrame(second,'event: ready');
 assert.equal((await (await f.request('/api/state')).json()).hubs.length,1);await second.cancel();
});
