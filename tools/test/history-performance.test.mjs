import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadConfig} from '../../analytics/runtime/config.mjs';
import {openDatabase} from '../../analytics/runtime/sqlite.mjs';
import {startServer} from '../../analytics/runtime/server.mjs';
import {beginHistoryFetch,storeHistorySnapshot} from '../../analytics/src/db.ts';
import {MAX_HISTORY_BODY_BYTES,fetchHistory} from '../../analytics/runtime/collection/history.mjs';

const enabled=process.env.TMA_RUN_HISTORY_PERFORMANCE==='1';
const outputPath=process.env.TMA_HISTORY_PERFORMANCE_OUTPUT??path.join('/tmp/tma-orchestration',`history-performance-${process.env.GITHUB_SHA??'working-tree'}.json`);

function historyPayload(){
 const start=Date.UTC(2025,0,1);
 const daily=Array.from({length:370},(_,index)=>({
  date:new Date(start+index*86400000).toISOString().slice(0,10),
  tokens:1,
  cost:0,
  messages:1,
 }));
 return {devices:Array.from({length:256},(_,index)=>({
  deviceId:`device-${String(index).padStart(3,'0')}`,
  updatedAt:'2025-12-31T00:00:00.000Z',
  historyAvailable:true,
  history:{daily,monthly:[{month:'2025-01',tokens:1,cost:0,messages:1}]},
 }))};
}

function sizedBody(payload,target){
 const copy={...payload,padding:''};
 let body=JSON.stringify(copy);
 let paddingLength=Math.max(0,target-Buffer.byteLength(body));
 copy.padding='x'.repeat(paddingLength);
 body=JSON.stringify(copy);
 while(Buffer.byteLength(body)<target){copy.padding+='x';body=JSON.stringify(copy);}
 while(Buffer.byteLength(body)>target){copy.padding=copy.padding.slice(0,-1);body=JSON.stringify(copy);}
 assert.equal(Buffer.byteLength(body),target);
 return body;
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

async function blockedHealthTransaction(app,normalized){
 const port=app.server.address().port;
 const fetchId=app.db.transaction(()=>beginHistoryFetch(app.db,'performance-hub'));
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(port,'127.0.0.1',()=>{
   const started=performance.now();
   socket.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
   const transactionStarted=performance.now();
   try{
    app.db.transaction(()=>storeHistorySnapshot(app.db,'performance-hub',normalized,fetchId,new Date().toISOString()));
   }catch(error){socket.destroy();reject(error);return;}
   const transactionMs=performance.now()-transactionStarted;
   let response='';
   socket.on('data',chunk=>{
    response+=chunk.toString();
    if(response.includes('\r\n\r\n')){
     const statusLine=response.slice(0,response.indexOf('\r\n'));
     socket.destroy();
     resolve({transactionMs,latencyMs:performance.now()-started,statusLine});
    }
   });
  });
  socket.once('error',reject);
 });
}

test('bounded near-limit history and synchronous shutdown performance artifact', {skip: !enabled, timeout: 90000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-history-performance-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const payload=historyPayload();
 const baselineBody=JSON.stringify(payload);
 const nearBody=sizedBody(payload,MAX_HISTORY_BODY_BYTES-1024);
 const overBody=sizedBody(payload,MAX_HISTORY_BODY_BYTES+1);
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
  const fetchId=db.transaction(()=>beginHistoryFetch(db,'performance-hub'));
  const started=performance.now();
  db.transaction(()=>storeHistorySnapshot(db,'performance-hub',baseline.value,fetchId,new Date().toISOString()));
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
 let closeMs;
 try{
  concurrent=await blockedHealthTransaction(app,baseline.value);
  const live=await new Promise((resolve,reject)=>{
   const request=http.get(`${config.publicOrigin}/api/live`,response=>{
    response.once('error',reject);response.once('data',()=>resolve({request,response}));
   });
   request.once('error',reject);
  });
  const closeStarted=performance.now();
  await app.close();
  closeMs=performance.now()-closeStarted;
  live.request.destroy();live.response.destroy();
 }catch(error){
  if(app.server.listening)await app.close();
  throw error;
 }

 const artifact={
  generatedAt:new Date().toISOString(),
  node:process.version,
  bodyBytes:{baseline:Buffer.byteLength(baselineBody),nearLimit:Buffer.byteLength(nearBody),overLimit:Buffer.byteLength(overBody),limit:MAX_HISTORY_BODY_BYTES},
  overLimitRejected,
  fetchMs:{baseline:baseline.elapsedMs,nearLimit:near.elapsedMs},
  rows:{devices:payload.devices.length,dailyPerDevice:payload.devices[0].history.daily.length},
  sqliteTransactionMs:transactionMs,
  concurrentHealth:{...concurrent,blockedByTransactionMs:concurrent.latencyMs-concurrent.transactionMs},
  closeMs,
 };
 fs.mkdirSync(path.dirname(outputPath),{recursive:true});
 fs.writeFileSync(outputPath,JSON.stringify(artifact,null,2)+'\n',{mode:0o600});
 assert.ok(transactionMs<15000,`history transaction exceeded 15s: ${transactionMs.toFixed(1)}ms`);
 assert.ok(concurrent.latencyMs<20000,`health response exceeded 20s: ${concurrent.latencyMs.toFixed(1)}ms`);
 assert.ok(closeMs<5000,`application close exceeded 5s: ${closeMs.toFixed(1)}ms`);
});
