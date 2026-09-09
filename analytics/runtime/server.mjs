import http from 'node:http';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig,credentials,validateTailnetBinding} from './config.mjs';
import {openDatabase} from './sqlite.mjs';
import {canView,allowedRequest} from './auth.mjs';
import {LiveFeed} from './live.mjs';
import {compactHubEvent} from '../src/protocol.ts';
import {recordObservation,dashboard,history,prune} from '../src/db.ts';
import {createManagementHandler} from './management.mjs';
import {listHubRecords, readHubSecretStore, recordContractSnapshots} from './hubs.mjs';
import {validateContracts} from '../src/estimate.ts';
import {UpdateManager} from './update-manager.mjs';
import {createCollectionManager} from './collection/manager.mjs';

const commonHeaders={
 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
function json(response,data,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));}
export async function startServer(config,{env=process.env,logger=console,maintenanceMs=300000,heartbeatMs=25000,collectionHubs,fetchImpl,collectionIdleMs,collectionHeaderTimeoutMs}={}){
 validateTailnetBinding(config);
 const auth=credentials(config,env);
 const db=openDatabase(config.databasePath,{demo:config.demo});
 let tail=Promise.resolve();
 const exclusive=callback=>{const next=tail.then(callback);tail=next.catch(()=>{});return next;};
 const live=new LiveFeed({heartbeatMs});
 let collectionFatal=false;
 let fatalPending=false;
 let closeApp=null;
 let collection;
 collection=createCollectionManager({
  idleMs:collectionIdleMs,
  headerTimeoutMs:collectionHeaderTimeoutMs,
  fetchImpl,
  onObservation:async({hubId,name,data,streamId}, lifecycle={})=>{
   let observation;
   try{observation=compactHubEvent({name,data},hubId,streamId);}
   catch(error){throw error;}
   try{
    const changed=await exclusive(()=>{
      // A management COMMIT synchronously invalidates the runner before
      // allowing old callbacks to enter this transaction.
      if (lifecycle.isCurrent && !lifecycle.isCurrent()) return [];
      return db.transaction(()=>recordObservation(db,observation,config.contracts,config.timeZone));
    });
    if(changed.length)live.updated(changed);
   }catch{
    throw Object.assign(new Error('observation storage failed'),{code:'storage_error',fatal:true});
   }
  },
  onStatus:()=>live.broadcast('manage_updated',{type:'manage_updated'}),
  onFatal:()=>{
   if(collectionFatal)return;
   collectionFatal=true;
   fatalPending=true;
   process.exitCode=1;
   logger.error('Observation persistence failed; collection stopped; inspect disk/database');
   void collection.stop();
   if(closeApp)void closeApp().catch(()=>{process.exitCode=1;});
  },
 });
 const stopCollection=()=>{
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(resolve,5000);timer.unref?.();});
  return Promise.race([collection.stop(),timeout]).finally(()=>clearTimeout(timer));
 };
 const hubRows=listHubRecords(db);
 try {
  // Contract IDs are current calculation settings and must refer to a real
  // non-archived SQLite Hub.  Historical snapshots are separate data.
 validateContracts(config.contracts, hubRows.filter(h=>h.status!=='archived').map(h=>h.id));
  db.transaction(()=>recordContractSnapshots(db, config.contracts));
 } catch (error) {
  await stopCollection();
  live.close();
  db.close();
  throw error;
 }
 const getCollectionStatuses=()=>Object.fromEntries(collection.getStatus().map(status=>[status.hubId,status]));
 const loadCollectionHubs=()=>{
  let secrets={};
  try { secrets=readHubSecretStore(config.hubSecretsPath).secrets; } catch { secrets={}; }
  return listHubRecords(db,{includeArchived:false}).filter(h=>h.status==='active').flatMap(h=>{
   const secret=secrets[h.secretRef];
   return typeof secret==='string'&&secret ? [{id:h.id,url:h.url,secret,status:h.status}] : [];
  });
 };
 const onHubCommitted=result=>{
  // This is called synchronously by management immediately after COMMIT.
  if (result?.reconnect) collection.invalidateHub(result.row.id);
  void collection.applyHubs(loadCollectionHubs()).catch(()=>logger.error('Hub collection reconciliation failed; inspect Hub status'));
 };
 const reconnectHub=id=>{
  collection.invalidateHub(id);
  void collection.applyHubs(loadCollectionHubs()).catch(()=>logger.error('Hub reconnect failed; inspect Hub status'));
 };
 const updateManager=new UpdateManager(config,live);
 updateManager.start();
 const management=createManagementHandler({config,auth,db,live,exclusive,getCollectionStatuses,onHubCommitted,onReconnect:reconnectHub,updateManager});
 const assets=new Map(['/','/index.html','/app.js','/styles.css'].map(route=>{
  const file=route==='/'?'index.html':route.slice(1);
  return [route,{bytes:fs.readFileSync(new URL(`../public/${file}`,import.meta.url)),type:file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'}];
 }));
 let closing=false;
 const handler=viewerOnly=>async(request,response)=>{
  for(const [name,value] of Object.entries(commonHeaders))response.setHeader(name,value);
  try{
   if(closing){json(response,{error:'shutting_down'},503);return;}
   if(!allowedRequest(request,config)){json(response,{error:'origin_rejected'},403);return;}
   const url=new URL(request.url,config.publicOrigin);
   if(url.pathname==='/api/health'&&request.method==='GET'){json(response,{ok:true,service:'token-monitor-analytics',version:'0.3.0',storage:'sqlite',demo:config.demo});return;}
   // The integrated process owns collection state.  The old Collector bridge
   // and status endpoint are deliberately absent from the public API.
   if(url.pathname==='/api/ingest'||url.pathname==='/api/collector/status'){
    json(response,{error:'not_found'},404);return;
   }
   if(url.pathname==='/api/manage/hubs'||url.pathname.startsWith('/api/manage/hubs/')){
    await management.handleManage(request,response,url);return;
   }
   if(url.pathname==='/api/manage/update'||url.pathname.startsWith('/api/manage/update/')){await management.handleManage(request,response,url);return;}
   if(!canView(request,config,auth)){
    if(config.viewerAuth.mode==='basic')response.setHeader('WWW-Authenticate','Basic realm="Token Monitor Analytics", charset="UTF-8"');
    json(response,{error:'viewer_auth_required'},401);return;
   }
   if(request.method!=='GET'&&request.method!=='HEAD'){json(response,{error:'method_not_allowed'},405);return;}
   if(url.pathname==='/api/live'){
    if(request.method!=='GET'){json(response,{error:'method_not_allowed'},405);return;}
    live.attach(request,response);return;
   }
   if(url.pathname==='/api/state'){
    const state=await exclusive(()=>dashboard(db,config.contracts));
    const currentHubs=listHubRecords(db,{includeArchived:false}).map(h=>({id:h.id,label:h.label,status:h.status,version:h.version,lastObservationAt:h.lastObservationAt,connection:getCollectionStatuses()[h.id]??null}));
    json(response,{...state,serverTime:new Date().toISOString(),demo:config.demo,configuredHubs:currentHubs,contracts:config.contracts,timeZone:config.timeZone,storage:'sqlite',runtime:'native-node',management:{enabled:Boolean(config.management?.enabled)}});return;
   }
   if(url.pathname==='/api/history'){
    const id=url.searchParams.get('contract')??'';
    if(!config.contracts.some(c=>c.id===id)){json(response,{error:'unknown_contract'},404);return;}
    json(response,{rows:await exclusive(()=>history(db,id))});return;
   }
   const asset=assets.get(url.pathname);
   if(!asset){json(response,{error:'not_found'},404);return;}
   response.writeHead(200,{'Content-Type':asset.type});response.end(request.method==='HEAD'?undefined:asset.bytes);
  }catch{
   logger.error('Request failed; sensitive details omitted. Check disk space and SQLite permissions.');
   if(!response.headersSent&&!response.destroyed)json(response,{error:'internal_error'},500);else response.destroy();
  }
 };
 const options={maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000,keepAliveTimeout:5000};
 const server=http.createServer(options,handler(false));
 const viewerServer=config.tailnetViewer?http.createServer(options,handler(true)):null;
 const servers=viewerServer?[server,viewerServer]:[server];
 const sockets=new Set();
 for(const server of servers){
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 }
 try{
  await exclusive(()=>prune(db,config.detailRetentionDays));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.listen.port,config.listen.host,resolve);});
  if(viewerServer)await new Promise((resolve,reject)=>{viewerServer.once('error',reject);viewerServer.listen(config.tailnetViewer.port,config.tailnetViewer.host,resolve);});
  await collection.start(collectionHubs!==undefined?collectionHubs:loadCollectionHubs());
 }catch(error){await stopCollection();live.close();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));db.close();throw error;}
 const maintenance=setInterval(()=>exclusive(()=>prune(db,config.detailRetentionDays)).catch(()=>logger.error('Retention maintenance failed; inspect disk/database')),maintenanceMs);
 maintenance.unref();
 logger.info(`Analytics ready at ${config.publicOrigin} (${config.demo?'DEMO':'REAL'}; SQLite; browser SSE)`);
 const app={
  server,viewerServer,db,live,updateManager,collection,
  startCollection: hubs => collection.start(hubs),
  async close(){
   if(closing)return;closing=true;clearInterval(maintenance);await stopCollection();live.close();updateManager.close();
   const force=setTimeout(()=>{for(const socket of sockets)socket.destroy();},5000);force.unref();
   await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));clearTimeout(force);
   await tail;db.close();
  }
 };
 closeApp=app.close;
 if(fatalPending)await app.close();
 return app;
}
async function main(){
 const {values}=parseArgs({options:{config:{type:'string',default:'config.local.json'}},strict:true});
 const config=loadConfig(values.config);
 const app=await startServer(config);
 let stopping=false;
 for(const name of ['SIGINT','SIGTERM'])process.on(name,async()=>{
  if(stopping)return;stopping=true;
  try{await app.close();}catch{process.exitCode=1;}
 });
}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 main().catch(error=>{console.error(`Analytics startup failed: ${error.message}`);process.exitCode=1;});
}
