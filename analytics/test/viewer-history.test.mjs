import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../runtime/config.mjs';
import {startServer} from '../runtime/server.mjs';
import {recordContractSnapshots} from '../runtime/hubs.mjs';

const waitFor=async(predicate,timeout=3000)=>{
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw new Error('condition timed out');
};

function upstreamHub(t){
 const streams=new Set();
 let revision=0;
 const at='2026-09-09T00:00:00.000Z';
 const history=()=>({devices:[{
  deviceId:'device-a',historyAvailable:true,updatedAt:at,
  periodWindows:{timeZone:'UTC',today:{key:'2026-09-09',endsAt:'2026-09-10T00:00:00Z'},month:{key:'2026-09',endsAt:'2026-10-01T00:00:00Z'}},
  history:{daily:[{date:'2026-09-01',tokens:10,cost:1,messages:2},{date:'2026-09-09',tokens:20,cost:2,messages:3}],monthly:[{month:'2026-09',tokens:30,cost:3,messages:5}]},
 }]});
 const streamPayload=()=>({type:'stats',at,stats:{updatedAt:at,deviceHistoryRevision:`revision-${revision}`,periods:{today:{costUsd:1},month:{costUsd:2},allTime:{costUsd:3}},devices:[{deviceId:'device-a',updatedAt:at,stale:false,periods:{allTime:{costUsd:3}}}],limits:{providers:[]}}});
 const server=http.createServer((request,response)=>{
  if(request.url==='/api/devices'){
   if(request.headers.authorization!=='Bearer hub-secret-123')return response.writeHead(401).end();
   response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(history()));return;
  }
  if(request.url==='/api/stats/stream'){
   if(request.headers.authorization!=='Bearer hub-secret-123')return response.writeHead(401).end();
   response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
   streams.add(response);response.write(`event: stats\ndata: ${JSON.stringify(streamPayload())}\n\n`);
   request.on('close',()=>streams.delete(response));return;
  }
  response.writeHead(404).end();
 });
 t.after(async()=>{for(const stream of streams)stream.destroy();await new Promise(resolve=>server.close(resolve));});
 return {server,history,increment(){revision++;for(const stream of streams)stream.write(`event: stats\ndata: ${JSON.stringify(streamPayload())}\n\n`);}};
}

async function appFixture(t,viewerAuth={mode:'loopback'}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-viewer-history-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const hub=upstreamHub(t);
 await new Promise(resolve=>hub.server.listen(0,'127.0.0.1',resolve));
 const raw=JSON.parse(fs.readFileSync(new URL('../configs/demo.json',import.meta.url),'utf8'));
 Object.assign(raw,{demo:false,databasePath:path.join(dir,'analytics.db'),hubSecretsPath:path.join(dir,'hub-secrets.json'),contracts:[],management:{enabled:true},viewerAuth});
 const file=path.join(dir,'analytics.json');fs.writeFileSync(file,JSON.stringify(raw));
 const config=loadConfig(file);config.listen.port=0;
 const env={TMA_VIEWER_USER:'viewer',TMA_VIEWER_PASSWORD:'history-viewer-password-123'};
 const app=await startServer(config,{env,logger:{info(){},error(){}},heartbeatMs:50,historyMinIntervalMs:0,historyRetryDelayMs:0,collectionIdleMs:1000});
 config.listen.port=app.server.address().port;config.publicOrigin=`${viewerAuth.mode==='basic'?'http':'http'}://127.0.0.1:${config.listen.port}`;
 const auth=viewerAuth.mode==='basic'?`Basic ${Buffer.from(`${env.TMA_VIEWER_USER}:${env.TMA_VIEWER_PASSWORD}`).toString('base64')}`:null;
 const request=(route,init={})=>fetch(config.publicOrigin+route,{...init,headers:{...(auth?{Authorization:auth}:{}),...(init.headers||{})}});
 const unauthRequest=(route,init={})=>fetch(config.publicOrigin+route,init);
 const hubUrl=`http://127.0.0.1:${hub.server.address().port}`;
 return {dir,config,app,hub,request,unauthRequest,hubUrl};
}

async function createHub(fixture){
 const response=await fixture.request('/api/manage/hubs',{method:'POST',headers:{Origin:fixture.config.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({id:'hub-a',label:'History Hub',url:fixture.hubUrl,secret:'hub-secret-123'})});
 assert.equal(response.status,200);
 return response.json();
}

test('one listener serves management, SSE collection, history, archive, stop/restart, and manual fetch',async t=>{
 const fixture=await appFixture(t);
 try{
  const usageModule=await fixture.request('/usage-history.mjs');
  assert.equal(usageModule.status,200);
  assert.match(usageModule.headers.get('content-type')??'',/text\/javascript/);
  assert.match(await usageModule.text(),/createUsageHistoryController/);
  await createHub(fixture);
  await waitFor(()=>fixture.app.db.sql.prepare("SELECT count(*) AS n FROM observations WHERE hub_id='hub-a'").get().n>0);
  await waitFor(()=>fixture.app.db.sql.prepare("SELECT last_status FROM usage_fetches WHERE hub_id='hub-a'").get()?.last_status==='success');
  const inactiveContract={id:'old-contract',label:'Old contract',hubId:'hub-a',provider:'provider',accountKey:'account',clientIds:['client'],deviceIds:['device-a'],windowKind:'weekly',windowHours:168,monthlyFeeUsd:10,attributionConfirmed:true,minDeltaPercent:1,maxSourceSkewSeconds:60,maxGapSeconds:600};
  fixture.app.db.transaction(()=>{recordContractSnapshots(fixture.app.db,[inactiveContract]);fixture.app.db.prepare('INSERT INTO daily_estimates(contract_id,day,last_observed_at,status,reason,last_valid_at,window_capacity_usd,monthly_capacity_usd,estimate_json) VALUES(?,?,?,?,?,?,?,?,?)').bind('old-contract','2026-09-01','2026-09-01T00:00:00.000Z','estimated','observed_delta','2026-09-01T00:00:00.000Z',10,10,JSON.stringify({monthlyCapacityUsd:10})).run();});
  const stateWithInactive=await (await fixture.request('/api/state')).json();assert.equal(stateWithInactive.contractHistory[0].id,'old-contract');assert.equal(stateWithInactive.contractHistory[0].active,false);
  const inactiveHistory=await fixture.request('/api/history?contract=old-contract');assert.equal(inactiveHistory.status,200);assert.equal((await inactiveHistory.json()).rows.length,1);

  const sources=await (await fixture.request('/api/usage-history/hubs')).json();
  assert.equal(sources.hubs.length,1);assert.equal(sources.hubs[0].devices[0].deviceId,'device-a');
  const daily=await fixture.request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=daily&from=2026-09-01&to=2026-09-09');
  assert.equal(daily.status,200);const dailyBody=await daily.json();assert.equal(dailyBody.rows.length,2);assert.equal(dailyBody.rows[0].current,true);assert.equal(dailyBody.source.historyState,'available');
  assert.equal((await fixture.request('/api/usage-history?hubId=hub-a&deviceId=missing&granularity=daily&from=2026-09-01&to=2026-09-09')).status,404);
  assert.equal((await fixture.request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=daily&from=2025-01-01&to=2027-01-01')).status,400);
  assert.equal((await fixture.request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=weekly&from=2026-09-01&to=2026-09-09')).status,400);
  const monthly=await fixture.request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=monthly&from=2026-08&to=2026-09');
  assert.equal(monthly.status,200);assert.equal((await monthly.json()).rows.length,1);

  const before=fixture.app.db.sql.prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-a'").get().last_attempt_fetch_id;
  const manual=await fixture.request('/api/manage/hubs/hub-a/history',{method:'POST',headers:{Origin:fixture.config.publicOrigin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(manual.status,202);
  await waitFor(()=>fixture.app.db.sql.prepare("SELECT last_attempt_fetch_id FROM usage_fetches WHERE hub_id='hub-a'").get().last_attempt_fetch_id>before);

  let manage=await (await fixture.request('/api/manage/hubs')).json();
  const disabled=await fixture.request('/api/manage/hubs/hub-a',{method:'PUT',headers:{Origin:fixture.config.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:manage.hubs[0].version,status:'disabled'})});
  assert.equal(disabled.status,200);
  await waitFor(()=>fixture.app.collection.getStatus().length===0);
  manage=await (await fixture.request('/api/manage/hubs')).json();
  const enabled=await fixture.request('/api/manage/hubs/hub-a',{method:'PUT',headers:{Origin:fixture.config.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:manage.hubs[0].version,status:'active'})});
  assert.equal(enabled.status,200);
  await waitFor(()=>fixture.app.db.sql.prepare("SELECT count(*) AS n FROM usage_fetches WHERE hub_id='hub-a'").get().n===1);
  await waitFor(()=>fixture.app.db.sql.prepare("SELECT last_status FROM usage_fetches WHERE hub_id='hub-a'").get()?.last_status==='success');
  manage=await (await fixture.request('/api/manage/hubs')).json();
  const archived=await fixture.request('/api/manage/hubs/hub-a',{method:'DELETE',headers:{Origin:fixture.config.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:manage.hubs[0].version})});
  assert.equal(archived.status,200);
  await waitFor(()=>fixture.app.collection.getStatus().length===0);
  const retained=await fixture.request('/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=daily&from=2026-09-01&to=2026-09-09');
  assert.equal(retained.status,200);const retainedBody=await retained.json();assert.equal(retainedBody.archived,true);assert.equal(retainedBody.rows.every(row=>row.current===false),true);
  await fixture.app.close();
  fixture.config.listen.port=0;
  const restarted=await startServer(fixture.config,{env:{TMA_VIEWER_USER:'viewer',TMA_VIEWER_PASSWORD:'history-viewer-password-123'},logger:{info(){},error(){}},historyMinIntervalMs:0});
  fixture.config.listen.port=restarted.server.address().port;fixture.config.publicOrigin=`http://127.0.0.1:${fixture.config.listen.port}`;
  const afterRestart=await fetch(fixture.config.publicOrigin+'/api/usage-history?hubId=hub-a&deviceId=device-a&granularity=monthly&from=2026-09&to=2026-09');
  assert.equal(afterRestart.status,200);await restarted.close();
 } finally {
  if(fixture.app.server.listening)await fixture.app.close();
 }
});

test('Basic viewer mode protects the history API while preserving Origin checks',async t=>{
 const fixture=await appFixture(t,{mode:'basic',userEnv:'TMA_VIEWER_USER',passwordEnv:'TMA_VIEWER_PASSWORD'});
 try{
  assert.equal((await fixture.unauthRequest('/api/usage-history/hubs')).status,401);
  const response=await fixture.request('/api/usage-history/hubs',{headers:{Origin:'https://evil.invalid'}});
  assert.equal(response.status,403);
 } finally {await fixture.app.close();}
});
