import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../../analytics/runtime/config.mjs';
import {openDatabase, transaction} from '../../analytics/runtime/sqlite.mjs';
import {startServer} from '../../analytics/runtime/server.mjs';
import {beginHistoryFetch,storeHistorySnapshot} from '../../analytics/src/db.ts';
import {MAX_HISTORY_BODY_BYTES,fetchHistory} from '../../analytics/runtime/collection/history.mjs';

const enabled=process.env.TMA_RUN_HISTORY_PERFORMANCE==='1';
const outputPath=process.env.TMA_HISTORY_PERFORMANCE_OUTPUT??path.join('/tmp/tma-orchestration',`history-performance-${process.env.GITHUB_SHA??'working-tree'}.json`);

function historyPayload({clientKeyLength=0}={}){
 const start=Date.UTC(2025,0,1);
 const perClient=clientKeyLength>0
  ? {[`c${'x'.repeat(clientKeyLength-1)}`]:{tokens:1,cost:0,messages:1}}
  : undefined;
 const daily=Array.from({length:370},(_,index)=>({
  date:new Date(start+index*86400000).toISOString().slice(0,10),
  tokens:1,
  cost:0,
  messages:1,
  ...(perClient?{perClient}:{}),
 }));
 return {devices:Array.from({length:256},(_,index)=>({
  deviceId:`device-${String(index).padStart(3,'0')}`,
  updatedAt:'2025-12-31T00:00:00.000Z',
  historyAvailable:true,
  history:{daily,monthly:[{month:'2025-01',tokens:1,cost:0,messages:1,...(perClient?{perClient}:{})}]},
 }))};
}

function nearLimitPayload(){
 let low=0,high=256,best=null,over=null;
 while(low<=high){
  const length=Math.floor((low+high)/2);
  const payload=historyPayload({clientKeyLength:length});
  const body=JSON.stringify(payload);
  if(Buffer.byteLength(body)<=MAX_HISTORY_BODY_BYTES-1024){
   best={clientKeyLength:length,payload,body};low=length+1;
  }else{over={clientKeyLength:length,payload,body};high=length-1;}
 }
 assert.ok(best,'a valid near-limit history fixture must fit below the body limit');
 let overLength=best.clientKeyLength+1;
 while(overLength<=256){
  const payload=historyPayload({clientKeyLength:overLength});
  const body=JSON.stringify(payload);
  if(Buffer.byteLength(body)>MAX_HISTORY_BODY_BYTES){over={clientKeyLength:overLength,payload,body};break;}
  overLength+=1;
 }
 assert.ok(over&&Buffer.byteLength(over.body)>MAX_HISTORY_BODY_BYTES,'a valid over-limit history fixture must exceed the body limit');
 return {best,over};
}

async function startHub(body){
 const server=http.createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json','content-length':String(Buffer.byteLength(body))});
  response.end(body);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {server,url:`http://127.0.0.1:${server.address().port}`};
}

async function closeServer(server){
 await new Promise(resolve=>server.close(()=>resolve()));
}

async function waitFor(predicate,timeoutMs=10000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(await predicate())return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error(`condition did not complete within ${timeoutMs}ms`);
}

async function connectedSocket(port,route){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(port,'127.0.0.1',()=>resolve({route,socket}));
  socket.once('error',reject);
 });
}

function responseHeader(socket,started){
 return new Promise((resolve,reject)=>{
  let response='';
  const onData=chunk=>{
   response+=chunk.toString();
   if(!response.includes('\r\n\r\n'))return;
   socket.off('error',onError);socket.off('data',onData);socket.destroy();
   resolve({statusLine:response.slice(0,response.indexOf('\r\n')),latencyMs:performance.now()-started});
  };
  const onError=error=>{socket.off('data',onData);reject(error);};
  socket.on('data',onData);socket.once('error',onError);
 });
}

async function blockedReadTransaction(app,normalized){
 const port=app.server.address().port;
 const fetchId=transaction(app.db,()=>beginHistoryFetch(app.db,'performance-hub'));
 const routes=['/api/health','/api/state'];
 const connections=await Promise.all(routes.map(route=>connectedSocket(port,route)));
 const started=performance.now();
 for(const {socket,route} of connections)socket.write(`GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
 const transactionStarted=performance.now();
 try{
  transaction(app.db,()=>storeHistorySnapshot(app.db,'performance-hub',normalized,fetchId,new Date().toISOString()));
 }catch(error){for(const {socket} of connections)socket.destroy();throw error;}
 const transactionMs=performance.now()-transactionStarted;
 const responses=await Promise.all(connections.map(({socket})=>responseHeader(socket,started)));
 return {transactionMs,latencyMs:Math.max(...responses.map(item=>item.latencyMs)),responses};
}

async function historyShutdownFixture(dir){
 let historyRequested=false;
 let historyAborted=false;
 const at='2025-12-31T00:00:00.000Z';
 const streamData=`event: stats\ndata: ${JSON.stringify({type:'stats',at,stats:{updatedAt:at,periods:{today:{costUsd:0},month:{costUsd:0},allTime:{costUsd:0}},devices:[],limits:{providers:[]}}})}\n\n`;
 const hubServer=http.createServer((request,response)=>{
  if(request.headers.authorization!=='Bearer performance-secret'){response.writeHead(401).end();return;}
  if(request.url==='/api/stats/stream'){
   response.writeHead(200,{'content-type':'text/event-stream'});response.write(streamData);
   request.once('close',()=>response.destroy());
   return;
  }
  if(request.url==='/api/devices'){
   historyRequested=true;
   response.writeHead(200,{'content-type':'application/json'});
   request.once('close',()=>{historyAborted=true;});
   const timer=setTimeout(()=>{if(!response.destroyed)response.end('{"devices":[]}');},30000);
   timer.unref?.();
   response.once('close',()=>clearTimeout(timer));
   return;
  }
  response.writeHead(404).end();
 });
 await new Promise((resolve,reject)=>{hubServer.once('error',reject);hubServer.listen(0,'127.0.0.1',resolve);});
 const hubUrl=`http://127.0.0.1:${hubServer.address().port}`;
 const configFile=path.join(dir,'shutdown.json');
 fs.writeFileSync(configFile,JSON.stringify({
  version:2,listen:{host:'127.0.0.1',port:8787},publicOrigin:'http://127.0.0.1:8787',
  databasePath:path.join(dir,'shutdown.db'),timeZone:'UTC',detailRetentionDays:7,
  hubSecretsPath:path.join(dir,'shutdown-secrets.json'),viewerAuth:{mode:'loopback'},contracts:[],demo:false,
  management:{enabled:true},update:{enabled:false},
 }));
 const config=loadConfig(configFile);config.listen.port=0;
 const app=await startServer(config,{logger:{info(){},error(){}},historyHeaderTimeoutMs:10000,historyBodyTimeoutMs:30000,historyMinIntervalMs:0,historyRetryDelayMs:0});
 config.listen.port=app.server.address().port;config.publicOrigin=`http://127.0.0.1:${config.listen.port}`;
 try{
  const response=await fetch(`${config.publicOrigin}/api/manage/hubs`,{method:'POST',headers:{Origin:config.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({id:'shutdown-hub',label:'Shutdown fixture',url:hubUrl,secret:'performance-secret'}),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);
  await waitFor(()=>historyRequested,10000);
  const started=performance.now();
  await app.close();
  const closeMs=performance.now()-started;
  await waitFor(()=>historyAborted,2000);
  return {closeMs,historyAborted};
 }finally{
  if(app.server.listening)await app.close();
  await closeServer(hubServer);
 }
}

test('bounded near-limit history and synchronous shutdown performance artifact', {skip: !enabled, timeout: 90000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-history-performance-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const payload=historyPayload();
 const baselineBody=JSON.stringify(payload);
 const nearLimit=nearLimitPayload();
 const nearBody=nearLimit.best.body;
 const overBody=nearLimit.over.body;
 const fetchTimed=async(body)=>{
  const replacement=await startHub(body);
  try{
   const started=performance.now();
   const value=await fetchHistory({hub:{id:'performance-hub',url:replacement.url,secret:'performance-secret'},headerTimeoutMs:10000,bodyTimeoutMs:30000});
   return {value,elapsedMs:performance.now()-started};
  }finally{await closeServer(replacement.server);}
 };

 const baseline=await fetchTimed(baselineBody);
 const near=await fetchTimed(nearBody);
 let overLimitRejected=false;
 await assert.rejects(()=>fetchTimed(overBody),error=>{
  overLimitRejected=error?.code==='body_too_large';
  return overLimitRejected;
 });

 const databasePath=path.join(dir,'analytics.db');
 const db=openDatabase(databasePath);
 let transactionMs;
 try{
  const fetchId=transaction(db,()=>beginHistoryFetch(db,'performance-hub'));
  const started=performance.now();
  transaction(db,()=>storeHistorySnapshot(db,'performance-hub',near.value,fetchId,new Date().toISOString()));
  transactionMs=performance.now()-started;
 }finally{db.close();}

 const configFile=path.join(dir,'analytics.json');
 fs.writeFileSync(configFile,JSON.stringify({
  version:2,listen:{host:'127.0.0.1',port:8787},publicOrigin:'http://127.0.0.1:8787',
  databasePath:path.join(dir,'app.db'),timeZone:'UTC',detailRetentionDays:7,
  hubSecretsPath:path.join(dir,'hub-secrets.json'),viewerAuth:{mode:'loopback'},contracts:[],demo:false,
  management:{enabled:false},update:{enabled:false},
 }));
 const config=loadConfig(configFile);config.listen.port=0;
 const app=await startServer(config,{logger:{info(){},error(){}}});
 config.listen.port=app.server.address().port;config.publicOrigin=`http://127.0.0.1:${config.listen.port}`;
 let concurrent;
 try{
  concurrent=await blockedReadTransaction(app,near.value);
  await app.close();
 }catch(error){
  if(app.server.listening)await app.close();
  throw error;
 }
 const shutdown=await historyShutdownFixture(dir);

 const artifact={
  generatedAt:new Date().toISOString(),
  node:process.version,
  bodyBytes:{baseline:Buffer.byteLength(baselineBody),nearLimit:Buffer.byteLength(nearBody),overLimit:Buffer.byteLength(overBody),limit:MAX_HISTORY_BODY_BYTES},
  overLimitRejected,
  fetchMs:{baseline:baseline.elapsedMs,nearLimit:near.elapsedMs},
  rows:{devices:payload.devices.length,dailyPerDevice:payload.devices[0].history.daily.length,nearClientKeyLength:nearLimit.best.clientKeyLength},
  sqliteTransactionMs:transactionMs,
  concurrentRequests:{...concurrent,blockedByTransactionMs:concurrent.latencyMs-concurrent.transactionMs},
  shutdown,
 };
 fs.mkdirSync(path.dirname(outputPath),{recursive:true});
 fs.writeFileSync(outputPath,JSON.stringify(artifact,null,2)+'\n',{mode:0o600});
 assert.equal(overLimitRejected,true);
 assert.ok(concurrent.responses.every(response=>response.statusLine.includes(' 200 ')),`health/state response failed: ${JSON.stringify(concurrent.responses)}`);
 assert.ok(transactionMs<10000,`history transaction exceeded 10s: ${transactionMs.toFixed(1)}ms`);
 assert.ok(concurrent.latencyMs<12000,`health/state response exceeded 12s: ${concurrent.latencyMs.toFixed(1)}ms`);
 assert.equal(shutdown.historyAborted,true);
 assert.ok(shutdown.closeMs<2000,`history shutdown exceeded 2s: ${shutdown.closeMs.toFixed(1)}ms`);
});
