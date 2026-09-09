import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';

const root=fileURLToPath(new URL('../..',import.meta.url));

function reservePort(){
 return new Promise((resolve,reject)=>{
  const listener=net.createServer();
  listener.once('error',reject);
  listener.listen(0,'127.0.0.1',()=>{
   const port=listener.address().port;
   listener.close(error=>error?reject(error):resolve(port));
  });
 });
}

function waitForExit(child,timeoutMs){
 return new Promise((resolve,reject)=>{
  if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
  let timer;
  const done=(error)=>{
   clearTimeout(timer);
   child.off('exit',onExit);
   child.off('error',onError);
   if(error)reject(error);else resolve();
  };
  const onExit=()=>done();
  const onError=error=>done(error);
  child.once('exit',onExit);
  child.once('error',onError);
  timer=setTimeout(()=>done(new Error(`Analytics child did not exit within ${timeoutMs}ms`)),timeoutMs);
  timer.unref?.();
 });
}

async function waitForReady(child,output,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(output.text.includes('Analytics ready at'))return;
  if(child.exitCode!==null||child.signalCode!==null){
   throw new Error(`Analytics child exited before readiness: ${output.text}`);
  }
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error(`Analytics child did not become ready within ${timeoutMs}ms: ${output.text}`);
}

async function waitForPort(port,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  try{
   await new Promise((resolve,reject)=>{
    const listener=net.createServer();
    listener.once('error',reject);
    listener.listen(port,'127.0.0.1',()=>listener.close(error=>error?reject(error):resolve()));
   });
   return;
  }catch{await new Promise(resolve=>setTimeout(resolve,25));}
 }
 throw new Error(`Analytics listener port ${port} remained occupied for ${timeoutMs}ms`);
}

function openLive(port){
 return new Promise((resolve,reject)=>{
  const request=http.get(`http://127.0.0.1:${port}/api/live`,response=>{
   response.once('error',reject);
   response.once('data',()=>resolve({request,response}));
  });
  request.once('error',reject);
 });
}

test('Analytics closes its listener and SQLite cleanly after the native Ctrl+C path', {timeout: 20000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-process-lifecycle-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const port=await reservePort();
 const databasePath=path.join(dir,'analytics.db');
 const configPath=path.join(dir,'analytics.json');
 fs.writeFileSync(configPath,JSON.stringify({
  version:2,
  listen:{host:'127.0.0.1',port},
  publicOrigin:`http://127.0.0.1:${port}`,
  databasePath,
  timeZone:'UTC',
  detailRetentionDays:7,
  hubSecretsPath:path.join(dir,'hub-secrets.json'),
  viewerAuth:{mode:'loopback'},
  contracts:[],
  demo:false,
  management:{enabled:true},
  update:{enabled:false},
 }));
 const output={text:''};
 const child=spawn(process.execPath,['--experimental-strip-types','analytics/runtime/server.mjs','--config',configPath],{
  cwd:root,
  env:{...process.env,TMA_NODE_LIFECYCLE_TEST:'1'},
  stdio:['ignore','pipe','pipe'],
  windowsHide:false,
 });
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{output.text+=chunk;});
 child.stderr.on('data',chunk=>{output.text+=chunk;});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');try{await waitForExit(child,2000);}catch{}}
 });

 await waitForReady(child,output,5000);
 const health=await fetch(`http://127.0.0.1:${port}/api/health`);
 assert.equal(health.status,200);
 assert.equal((await health.json()).storage,'sqlite');
 const live=await openLive(port);

 // `child.kill('SIGINT')` maps to the native Ctrl+C signal on POSIX. Node's
 // Windows implementation force-terminates for this API, so the Windows
 // assertion below is deliberately bounded to the externally observable
 // contract: the listener and database must be released promptly. The
 // QEMU/desktop run remains the evidence for a real console Ctrl+C event.
 assert.equal(child.kill('SIGINT'),true);
 await waitForExit(child,8000);
 live.request.destroy();live.response.destroy();
 await waitForPort(port,2000);

 const db=new DatabaseSync(databasePath,{readOnly:true});
 try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}
 finally{db.close();}
});
