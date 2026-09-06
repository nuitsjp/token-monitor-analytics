import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJSON,selectConfiguration,validateConfiguration,writeChanged,treeDigest} from './publish-config.mjs';

import {tailnetIdentity,inherit,report,userEnvironment} from './ubuntu-common.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
import {prefix,destination,appUnits as units,infrastructureFile,digest,validateInfrastructure,assertInfrastructureFile} from './ubuntu-layout.mjs';
function run(command,args,options={}){
 try{return execFileSync(command,args,{encoding:'utf8',stdio:'pipe',...options});}
 catch{throw new Error(`${path.basename(command)} failed; inspect the host configuration locally (command output suppressed to protect secrets).`);}
}
const systemctl=(...args)=>run('/usr/bin/systemctl',['--user',...args]);
const active=name=>spawnSync('/usr/bin/systemctl',['--user','is-active','--quiet',name]).status===0;
function regular(filename){if(!fs.lstatSync(filename).isFile())throw new Error('Expected a regular deployment file.');}
async function portAvailable(port){
 const server=net.createServer();
 await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error(`Port ${port} is occupied; choose another port or explicitly stop its owner.`)));server.listen(port,'0.0.0.0',resolve);});
 await new Promise(resolve=>server.close(resolve));
}
function viewerRequest(plan,route,{authorization,local=false,sse=false}={}){
 return new Promise((resolve,reject)=>{
  const request=http.request({hostname:plan.hostname,port:plan.port,path:route,method:'GET',headers:{Host:new URL(plan.publicOrigin).host,...(authorization?{Authorization:authorization}:{})}},response=>{
   let body='';response.setEncoding('utf8');
   response.on('data',chunk=>{body+=chunk;if(sse&&body.includes('event: ready')){resolve(response.statusCode);response.destroy();}if(body.length>2**20)response.destroy(new Error('Unexpected response size.'));});
   response.on('end',()=>resolve(response.statusCode));response.on('error',reject);
  });
  const timer=setTimeout(()=>request.destroy(new Error('Tailnet HTTP verification timed out.')),10000);
  request.on('close',()=>clearTimeout(timer));request.on('error',()=>reject(new Error('Tailnet HTTP verification failed; check Tailscale and the viewer listener.')));request.end();
 });
}
async function verify(plan,config){
 for(const unit of units){if(!active(unit)||systemctl('is-enabled',unit).trim()!=='enabled')throw new Error('A published service is not active and enabled.');}
 const authorization=config.analytics.viewerAuth.mode==='basic'?`Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString('base64')}`:undefined;
 for(const local of [false]){
  for(const [route,auth,expected] of [['/api/state',undefined,authorization?401:200],['/api/ingest',undefined,404],['/',authorization,200],['/api/state',authorization,200]]){
   if(await viewerRequest(plan,route,{authorization:auth,local})!==expected)throw new Error('Tailnet authentication/routing verification failed.');
  }
  if(await viewerRequest(plan,'/api/live',{authorization,local,sse:true})!==200)throw new Error('Tailnet SSE verification failed.');
 }
 console.log('PASS: user services active/enabled, tailnet HTTP, configured viewer access, private ingest, SSE.');
}
async function apply(architecture){
 if(process.getuid()===0)throw new Error('Publish as the configured ordinary user; root publication is prohibited.');
 assertInfrastructureFile();
 const infrastructure=readJSON(infrastructureFile);
 const plan=readJSON(`${destination}/connection.json`);
 const identity=tailnetIdentity();
 if(plan.tailnetIP!==identity.tailnetIP||plan.hostname!==identity.hostname)throw new Error('Tailscale identity changed; rerun configure:ubuntu.');
 const selected=selectConfiguration({});
 let config;
 try{config=validateConfiguration(plan,selected);}catch{throw new Error('Installed application configuration failed validation; inspect private files locally.');}
 validateInfrastructure(infrastructure,process.getuid());
 if(run('/usr/bin/loginctl',['show-user',String(process.getuid()),'-p','Linger','--value']).trim()!=='yes')throw new Error('Boot persistence is not configured; run provision:ubuntu as administrator.');
 for(const filename of Object.values(selected))regular(filename);
 if(!active(units[0]))await portAvailable(config.analytics.listen.port);
 const archive=path.join(root,`dist/tma-ubuntu-${architecture}.tar.gz`);
 const archiveBytes=fs.readFileSync(archive),archiveHash=digest(archiveBytes);
 if(fs.readFileSync(`${archive}.sha256`,'utf8')!==`${archiveHash}  ${path.basename(archive)}\n`)throw new Error('Release checksum mismatch.');
 fs.accessSync(`${prefix}/releases`,fs.constants.W_OK);
 fs.accessSync('/var/lib/tma-analytics/backups',fs.constants.W_OK);
 const container=fs.mkdtempSync(`${prefix}/.publish-`),stage=`${container}/payload`,snapshot=`${container}/release.tar.gz`;
 try{
  fs.writeFileSync(snapshot,archiveBytes,{mode:0o600});fs.mkdirSync(stage);
  const entries=run('/usr/bin/tar',['-tzf',snapshot]).trim().split('\n');
  if(entries.some(n=>!n.startsWith('./')||n.split('/').includes('..')))throw new Error('Unsafe archive path.');
  if(run('/usr/bin/tar',['-tvzf',snapshot]).trim().split('\n').some(line=>!['-','d'].includes(line[0])))throw new Error('Archive links/special files are not allowed.');
  run('/usr/bin/tar',['-xzf',snapshot,'--no-same-owner','-C',stage]);
  fs.copyFileSync(process.execPath,`${stage}/node`);fs.chmodSync(`${stage}/node`,0o755);
  // Validate the actual packaged binary and native runtime, without connecting to a Hub.
  run(`${stage}/tma-collector`,['-check','-config',selected.collectorConfig],{env:{PATH:'/usr/bin:/bin',...config.collectorEnv}});
  run(`${stage}/node`,['--experimental-strip-types','--input-type=module','-e',"import './analytics/runtime/server.mjs'; import {DatabaseSync} from 'node:sqlite'; new DatabaseSync(':memory:').close();"],{cwd:stage});
  const releaseId=treeDigest(stage);
  if(fs.existsSync(config.analytics.databasePath)){
   run(`${stage}/node`,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{if(db.prepare(\"SELECT value FROM app_metadata WHERE key='dataset_mode'\").get()?.value!=='real')process.exitCode=1;}finally{db.close();}",config.analytics.databasePath]);
  }
  const current=`${prefix}/current`,release=`${prefix}/releases/${releaseId}`;
  const currentRelease=fs.existsSync(current)?fs.realpathSync(current):null;
  const configurationId=digest(JSON.stringify([Object.values(selected).map(p=>digest(fs.readFileSync(p))),infrastructure.unitDigest]));
  const recordPath=`${prefix}/publication.json`;
  const previous=fs.existsSync(recordPath)?readJSON(recordPath):{};
  const appChanged=currentRelease!==release||previous.configurationId!==configurationId;
  if(fs.existsSync(release)&&treeDigest(release)!==releaseId)throw new Error('Installed release content changed; refusing to reuse it.');
  if(fs.existsSync(current)&&!fs.lstatSync(current).isSymbolicLink())throw new Error('Deployment current path must be a managed symlink.');
  if(appChanged){
   // Preserve all data. A failed migration must not roll code back over a newer DB schema.
   for(const unit of [units[1],units[0]])if(systemctl('show','--property=LoadState','--value',unit).trim()!=='not-found')systemctl('stop',unit);
   if(fs.existsSync(config.analytics.databasePath)){
    const backup=`/var/lib/tma-analytics/backups/before-${Date.now()}-${releaseId.slice(0,12)}.db`;
    // The staged reader understands the newly configured viewer mode.
    const backupRuntime=stage;
    run(`${stage}/node`,['--experimental-strip-types',`${backupRuntime}/analytics/runtime/backup.mjs`,'--config',`${destination}/analytics.json`,'--output',backup]);
    fs.chmodSync(backup,0o600);
   }
   if(!fs.existsSync(release)){
    fs.renameSync(stage,release);fs.chmodSync(release,0o755);
   }
   const next=`${prefix}/.current-${process.pid}`;
   try{fs.symlinkSync(release,next);fs.renameSync(next,current);}finally{fs.rmSync(next,{force:true});}
  }
  if(!appChanged)console.log('SKIP: application release and configuration already match.');
  for(const name of units){
   if(spawnSync('/usr/bin/systemctl',['--user','is-enabled',name],{encoding:'utf8'}).stdout?.trim()!=='enabled')systemctl('enable',name);
  }
  systemctl('reset-failed',...units);
  if(!active(units[0]))systemctl('start',units[0]);
  let healthy=false;
  for(let i=0;i<40;i++){
   try{const r=await fetch(`http://127.0.0.1:${config.analytics.listen.port}/api/health`,{signal:AbortSignal.timeout(1000)});const body=await r.json();if(r.ok&&body.demo===false){healthy=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!healthy)throw new Error('Analytics failed health check; inspect its user service.');
  if(!active(units[1]))systemctl('start',units[1]);
  // Allow services to report startup errors and the tailnet listener to become ready.
  await new Promise(resolve=>setTimeout(resolve,1500));
  await verify(plan,config);
  writeChanged(recordPath,`${JSON.stringify({releaseId,configurationId,publicOrigin:plan.publicOrigin},null,2)}\n`,0o600);
  console.log(appChanged?'Published Ubuntu release. Existing settings, SQLite and outbox preserved.':'Publication already current; service enablement and tailnet HTTP verified.');
 }finally{fs.rmSync(container,{recursive:true,force:true});}
}
async function main(){
 const {values}=parseArgs({options:{apply:{type:'boolean',default:false}},strict:true});
 userEnvironment();
 if(!['x64','arm64'].includes(process.arch))throw new Error('Publication supports Ubuntu amd64/arm64.');
 const architecture=process.arch==='x64'?'amd64':'arm64';
 if(!fs.existsSync(infrastructureFile))throw new Error('Infrastructure is not provisioned. Run provision:ubuntu first.');
 assertInfrastructureFile();validateInfrastructure(readJSON(infrastructureFile),process.getuid());
 if(!fs.existsSync(`${destination}/analytics.json`)||!fs.existsSync(`${destination}/collector.json`))throw new Error('Application configuration is incomplete. Run configure:ubuntu with real Hub input.');
 if(values.apply){
  // The lock covers build, verification and placement of the same snapshot.
  run('mise',['run',`release:ubuntu:${architecture}`],{cwd:root,stdio:'inherit'});
  await apply(architecture);return;
 }
 inherit('/usr/bin/flock',['--nonblock','-E','75','/var/lib/tma-lock/deploy.lock',process.execPath,'--experimental-strip-types',fileURLToPath(import.meta.url),'--apply'],{lock:true});
}
main().catch(report);
