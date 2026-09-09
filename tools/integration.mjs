// Node-only native integration. Exercises the current v2 Hub/Analytics
// contract without the retired Go Collector or an outbox bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig} from '../analytics/runtime/config.mjs';
import {startServer} from '../analytics/runtime/server.mjs';
import {backupDatabase} from '../analytics/runtime/sqlite.mjs';
import {startMockHub} from './mockhub.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const at='2026-09-09T00:00:00.000Z';
const periodWindows={timeZone:'UTC',today:{key:'2026-09-09',endsAt:'2026-09-10T00:00:00.000Z'},month:{key:'2026-09',endsAt:'2026-10-01T00:00:00.000Z'}};
const historyA={daily:[
 {date:'2026-09-08',tokens:12,cost:1.2,messages:2},
 {date:'2026-09-09',tokens:24,cost:2.4,messages:4},
],monthly:[{month:'2026-09',tokens:36,cost:3.6,messages:6}]};
const historyB={daily:[
 {date:'2026-09-08',tokens:8,cost:0.8,messages:1},
 {date:'2026-09-09',tokens:16,cost:1.6,messages:2},
],monthly:[{month:'2026-09',tokens:24,cost:2.4,messages:3}]};

function device(deviceId,history){
 return {
  deviceId,hostname:deviceId,platform:'linux-x64',agentVersion:'mockhub',updatedAt:at,stale:false,
  today:{totalTokens:24,costUsd:2.4},month:{totalTokens:36,costUsd:3.6},allTime:{totalTokens:36,costUsd:3.6},
  periodWindows,historyAvailable:true,history,
 };
}

async function waitFor(predicate,label,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  try{const value=await predicate();if(value)return value;}catch{}
  await delay(50);
 }
 throw new Error(`Timed out: ${label}`);
}

async function readUntil(reader,needle,timeout=10000){
 let text='';
 const decoder=new TextDecoder();
 const timer=setTimeout(()=>reader.cancel(),timeout);
 timer.unref?.();
 try{
  while(!text.includes(needle)){
   const next=await reader.read();
   if(next.done)throw new Error(`Browser SSE ended before ${needle}`);
   text+=decoder.decode(next.value,{stream:true});
   if(text.length>1024*1024)throw new Error('Browser SSE response exceeded the test limit');
  }
  return text;
 }finally{clearTimeout(timer);}
}

function rowCount(db,table){
 return Number(db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total);
}

async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tma-integration-node-'));
 const hubs=[];
 let app=null;
 let liveReader=null;
 try{
  hubs.push(await startMockHub({
   listen:'127.0.0.1:0',secret:'hub-a-secret',intervalMs:40,disconnectAfter:2,
   devices:[device('device-a',historyA)],
  }));
  hubs.push(await startMockHub({
   listen:'127.0.0.1:0',secret:'hub-b-secret',intervalMs:40,
   devices:[device('device-b',historyB)],
  }));

  const raw=JSON.parse(fs.readFileSync(path.join(root,'analytics/configs/demo.json'),'utf8'));
  Object.assign(raw,{
   demo:false,
   databasePath:path.join(temp,'analytics.db'),
   hubSecretsPath:path.join(temp,'hub-secrets.json'),
   contracts:[],
   management:{enabled:true},
  });
  const configFile=path.join(temp,'analytics.json');
  fs.writeFileSync(configFile,JSON.stringify(raw));
  const config=loadConfig(configFile);
  config.listen.port=0;
  const serverOptions={
   logger:{info(){},error(error){console.error(error?.message??error);}},
   heartbeatMs:50,
   historyMinIntervalMs:0,
   historyRetryDelayMs:0,
   collectionIdleMs:1000,
  };
  app=await startServer(config,serverOptions);
  config.listen.port=app.server.address().port;
  config.publicOrigin=`http://127.0.0.1:${config.listen.port}`;
  const origin=()=>config.publicOrigin;
  const request=(route,init={})=>fetch(origin()+route,init);
  const database=()=>app.db.sql;

  const moduleResponse=await request('/usage-history.mjs');
  assert.equal(moduleResponse.status,200);
  assert.match(moduleResponse.headers.get('content-type')??'',/text\/javascript/);

  const live=await request('/api/live');
  assert.equal(live.status,200);
  assert.ok(live.body);
  liveReader=live.body.getReader();
  await readUntil(liveReader,'event: ready');

  for(const [index,hub] of hubs.entries()){
   const id=`hub-${index===0?'a':'b'}`;
   const response=await request('/api/manage/hubs',{
    method:'POST',
    headers:{Origin:origin(),'Content-Type':'application/json'},
    body:JSON.stringify({id,label:`Hub ${id}`,url:hub.origin,secret:hub.secret}),
   });
   assert.equal(response.status,200,await response.text());
  }

  await waitFor(()=>hubs.every((_,index)=>{
   const id=`hub-${index===0?'a':'b'}`;
   return database().prepare('SELECT count(*) AS total FROM observations WHERE hub_id=?').get(id).total>0;
  }),'live Hub observations');
  await waitFor(()=>hubs.every((_,index)=>{
   const id=`hub-${index===0?'a':'b'}`;
   return database().prepare('SELECT last_status FROM usage_fetches WHERE hub_id=?').get(id)?.last_status==='success';
  }),'initial history fetches');
  await readUntil(liveReader,'event: updated');

  const state=await (await request('/api/state')).json();
  assert.deepEqual(state.configuredHubs.map(hub=>hub.id).sort(),['hub-a','hub-b']);
  assert.equal((await request('/api/ingest')).status,404);
  assert.equal((await request('/api/collector/status')).status,404);
  assert.equal(fs.existsSync(path.join(temp,'outbox')),false);
  console.log('PASS: Hub SSE -> Analytics -> SQLite -> browser SSE, with no ingest/outbox bridge');

  const daily=await request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=daily&from=2026-09-08&to=2026-09-09');
  assert.equal(daily.status,200);
  const dailyBody=await daily.json();
  assert.equal(dailyBody.rows.length,2);
  assert.equal(dailyBody.rows.at(-1).tokens,24);
  const beforePeriodRows=rowCount(database(),'usage_periods');
  const beforeFetchId=Number(database().prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-a'").get().last_attempt_fetch_id);

  hubs[0].setDeviceHistory('device-a',{
   ...historyA,
   daily:[historyA.daily[0],{date:'2026-09-09',tokens:99,cost:9.9,messages:9}],
  });
  await waitFor(()=>{
   const row=database().prepare("SELECT last_attempt_fetch_id,last_status FROM usage_fetches WHERE hub_id='hub-a'").get();
   return Number(row?.last_attempt_fetch_id)>beforeFetchId&&row?.last_status==='success';
  },'history revision refetch');
  const revised=await request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=daily&from=2026-09-09&to=2026-09-09');
  assert.equal(revised.status,200);
  assert.equal((await revised.json()).rows[0].tokens,99);
  assert.equal(rowCount(database(),'usage_periods'),beforePeriodRows);
  console.log('PASS: revision refetch replaces the current period atomically without duplicate rows');

  await waitFor(()=>Number(database().prepare("SELECT count(DISTINCT stream_id) AS total FROM observations WHERE hub_id='hub-a'").get().total)>=2,'Hub SSE reconnect');
  console.log('PASS: forced Hub disconnect reconnects and records a new stream segment');

  const beforeRestartObservations=rowCount(database(),'observations');
  await liveReader.cancel();
  liveReader=null;
  await app.close();
  app=null;
  config.listen.port=0;
  app=await startServer(config,serverOptions);
  config.listen.port=app.server.address().port;
  config.publicOrigin=`http://127.0.0.1:${config.listen.port}`;
  const restartedLive=await request('/api/live');
  assert.equal(restartedLive.status,200);
  liveReader=restartedLive.body.getReader();
  await readUntil(liveReader,'event: ready');
  await waitFor(()=>rowCount(database(),'observations')>beforeRestartObservations,'post-restart Hub observation');
  const restartedState=await (await request('/api/state')).json();
  assert.deepEqual(restartedState.configuredHubs.map(hub=>hub.id).sort(),['hub-a','hub-b']);
  const uniqueness=database().prepare('SELECT count(*) AS total,count(DISTINCT event_id) AS unique_ids FROM observations').get();
  assert.equal(Number(uniqueness.total),Number(uniqueness.unique_ids));
  const monthly=await request('/api/usage-history?hubId=hub-b&deviceId=device-b&granularity=monthly&from=2026-09&to=2026-09');
  assert.equal(monthly.status,200);
  assert.equal((await monthly.json()).rows.length,1);
  console.log('PASS: restart reloads Hub registrations/secrets, resumes SSE, and keeps event IDs unique');

  const backupFile=path.join(temp,'analytics-backup.db');
  await backupDatabase(config.databasePath,backupFile);
  const backup=new DatabaseSync(backupFile,{readOnly:true});
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.ok(Number(backup.prepare('SELECT count(*) AS total FROM observations').get().total)>=beforeRestartObservations);
  backup.close();
  assert.equal(database().prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log('PASS: live database and backup pass SQLite integrity checks');
  console.log('INTEGRATION OK');
 }finally{
  if(liveReader)await liveReader.cancel().catch(()=>{});
  if(app)await app.close().catch(error=>console.error(error?.message??error));
  for(const hub of hubs)await hub.close().catch(error=>console.error(error?.message??error));
  fs.rmSync(temp,{recursive:true,force:true});
 }
}

main().catch(error=>{
 console.error(`INTEGRATION FAILED: ${error?.stack??error}`);
 process.exitCode=1;
});
