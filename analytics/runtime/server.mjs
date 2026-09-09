import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig,credentials,validateTailnetBinding} from './config.mjs';
import {openDatabase,transaction} from './sqlite.mjs';
import {canView,allowedRequest} from './auth.mjs';
import {LiveFeed} from './live.mjs';
import {compactHubEvent} from '../src/protocol.ts';
import {
 recordObservation,dashboard,history as contractHistory,prune,beginHistoryFetch,storeHistorySnapshot,
 recordHistoryFetchFailure,readUsageHistory,listUsageHistorySources,historyFetchStatus,
} from '../src/db.ts';
import {createManagementHandler} from './management.mjs';
import {listHubRecords,getHubRecord,readHubSecretStore,recordContractSnapshots,listContractSnapshots} from './hubs.mjs';
import {validateContracts} from '../src/estimate.ts';
import {isSafeId} from '../src/hubs.ts';
import {UpdateManager} from './update-manager.mjs';
import {createCollectionManager} from './collection/manager.mjs';
import {createHistoryScheduler} from './collection/history.mjs';

const commonHeaders={
 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
const knownApiPaths=new Set(['/api/health','/api/live','/api/state','/api/usage-history/hubs','/api/usage-history/sources','/api/usage-history','/api/history']);
function json(response,data,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));}

function releaseIdentity(){
 const candidates=[new URL('../release-manifest.json',import.meta.url),new URL('../../release-manifest.json',import.meta.url)];
 for(const candidate of candidates){
  try{
   const filename=fileURLToPath(candidate);
   if(!fs.existsSync(filename)||fs.statSync(filename).size>16384)continue;
   const raw=JSON.parse(fs.readFileSync(filename,'utf8'));
   if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
   const value=(name,pattern)=>typeof raw[name]==='string'&&pattern.test(raw[name])?raw[name]:null;
   const releaseId=value('releaseId',/^[A-Za-z0-9._-]{1,128}$/);
   const commitSha=value('commitSha',/^[a-f0-9]{40}$/i)??value('targetCommitSha',/^[a-f0-9]{40}$/i);
   const targetCommitSha=value('targetCommitSha',/^[a-f0-9]{40}$/i)??commitSha;
   const contentHash=value('contentHash',/^[a-f0-9]{32,128}$/i);
   const commitDate=value('commitDate',/^\d{4}-\d{2}-\d{2}T/);
   if(releaseId||commitSha||contentHash)return {releaseId,commitSha,targetCommitSha,contentHash,commitDate};
  }catch{}
 }
 return null;
}

function requestError(message,status,code){return Object.assign(new Error(message),{status,code});}

function dateKey(value,granularity,label){
 if(typeof value!=='string')throw requestError(`Invalid ${label}`,400,'invalid_history_date');
 const pattern=granularity==='daily'?/^\d{4}-\d{2}-\d{2}$/:/^\d{4}-\d{2}$/;
 if(!pattern.test(value))throw requestError(`Invalid ${label}`,400,'invalid_history_date');
 const year=Number(value.slice(0,4));
 if(year<1||year>9999)throw requestError(`Invalid ${label}`,400,'invalid_history_date');
 const date=new Date(`${granularity==='daily'?value:`${value}-01`}T00:00:00.000Z`);
 const expected=granularity==='daily'?value:value;
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,granularity==='daily'?10:7)!==expected)throw requestError(`Invalid ${label}`,400,'invalid_history_date');
 return value;
}

function historyQuery(url){
 const hubId=url.searchParams.get('hubId');
 const deviceId=url.searchParams.get('deviceId');
 const granularity=url.searchParams.get('granularity');
 const from=url.searchParams.get('from');
 const to=url.searchParams.get('to');
 if(!isSafeId(hubId)||typeof deviceId!=='string'||deviceId.length<1||deviceId.length>256||!['daily','monthly'].includes(granularity))throw requestError('Invalid usage history query',400,'invalid_history_query');
 if(from===null||to===null)throw requestError('History range is required',400,'invalid_history_range');
 dateKey(from,granularity,'from');dateKey(to,granularity,'to');
 let size;
 if(granularity==='daily'){
  const start=Date.parse(`${from}T00:00:00.000Z`),end=Date.parse(`${to}T00:00:00.000Z`);
  size=Math.floor((end-start)/86400000)+1;
 }else{
  size=(Number(to.slice(0,4))-Number(from.slice(0,4)))*12+Number(to.slice(5))-Number(from.slice(5))+1;
 }
 if(size<1)throw requestError('History range is reversed',400,'invalid_history_range');
 if(size>(granularity==='daily'?366:120))throw requestError('History range is too large',400,'history_range_too_large');
 return {hubId,deviceId,granularity,from,to};
}

function publicContractHistory(db,activeContracts){
 const active=new Set(activeContracts.map(contract=>contract.id));
 const seen=new Set();
 return listContractSnapshots(db).filter(snapshot=>{
  if(seen.has(snapshot.id))return false;
  seen.add(snapshot.id);
  return true;
 }).map(snapshot=>({id:snapshot.id,label:snapshot.label,hubId:snapshot.hubId,capturedAt:snapshot.capturedAt,active:active.has(snapshot.id)}));
}
export async function startServer(config,{env=process.env,logger=console,maintenanceMs=300000,heartbeatMs=25000,collectionHubs,fetchImpl,collectionIdleMs,collectionHeaderTimeoutMs,historyHeaderTimeoutMs,historyBodyTimeoutMs,historyMinIntervalMs,historyRetryDelayMs,updateManagerOptions={}}={}){
 validateTailnetBinding(config);
 const auth=credentials(config,env);
 const db=openDatabase(config.databasePath,{demo:config.demo});
 const release=releaseIdentity();
 let tail=Promise.resolve();
 const exclusive=callback=>{const next=tail.then(callback);tail=next.catch(()=>{});return next;};
 const live=new LiveFeed({heartbeatMs});
 let collectionFatal=false;
 let historyFatal=false;
 let fatalPending=false;
 let closeApp=null;
 let collection;
 const collectionGenerations=new Map();
 const collectionGenerationIsCurrent=(hubId,generation)=>collectionGenerations.get(hubId)===generation;

 let history;
 history=createHistoryScheduler({
  fetchImpl,
  headerTimeoutMs:historyHeaderTimeoutMs,
  bodyTimeoutMs:historyBodyTimeoutMs,
  minIntervalMs:historyMinIntervalMs,
  retryDelayMs:historyRetryDelayMs,
  onFetchStart:async({hub,generation,startedAt})=>exclusive(()=>{
   if(!collectionGenerationIsCurrent(hub.id,generation))return false;
   const row=getHubRecord(db,hub.id);
   if(!row||row.status!=='active')return false;
   return transaction(db,()=>beginHistoryFetch(db,hub.id,startedAt));
  }),
  onSuccess:async({hub,generation,fetchId,completedAt,response})=>{
   const stored=await exclusive(()=>{
    // A management COMMIT fences the collection generation synchronously.
    // This check is inside the serialized writer tail, immediately before
    // the synchronous history transaction, so an old response cannot land
    // after a replacement has committed.
    if(!collectionGenerationIsCurrent(hub.id,generation))return false;
    const row=getHubRecord(db,hub.id);
    if(!row||row.status!=='active')return false;
    transaction(db,()=>storeHistorySnapshot(db,hub.id,response,fetchId,completedAt));
    return true;
   });
   if(stored)live.broadcast('manage_updated',{type:'manage_updated'});
   return stored;
  },
  onFailure:async({hub,generation,fetchId,errorCode})=>exclusive(()=>{
   if(!collectionGenerationIsCurrent(hub.id,generation))return false;
   const row=getHubRecord(db,hub.id);
   if(!row||row.status!=='active')return false;
   transaction(db,()=>recordHistoryFetchFailure(db,hub.id,fetchId,errorCode));
   live.broadcast('manage_updated',{type:'manage_updated'});
   return true;
  }),
  onStatus:()=>live.broadcast('manage_updated',{type:'manage_updated'}),
  onFatal:error=>{
   if(historyFatal)return;
   historyFatal=true;
   fatalPending=true;
   process.exitCode=1;
   logger.error('History persistence failed; collection stopped; inspect disk/database');
   void history.stop();
   if(collection)void collection.stop();
   if(closeApp)void closeApp().catch(()=>{process.exitCode=1;});
  },
 });
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
      return transaction(db,()=>recordObservation(db,observation,config.contracts,config.timeZone));
    });
    if(changed.length)live.updated(changed);
   }catch{
    throw Object.assign(new Error('observation storage failed'),{code:'storage_error',fatal:true});
   }
  },
  onConnected:({hub,generation})=>{
   collectionGenerations.set(hub.id,generation);
   void history.startHub(hub,generation).catch(()=>logger.error(`History scheduler failed for ${hub.id}; inspect the Hub history status`));
  },
  onRevision:({hubId,revision,generation})=>history.notifyRevision(hubId,revision,generation),
  onStopped:({hub,generation})=>{
   if(collectionGenerationIsCurrent(hub.id,generation))collectionGenerations.delete(hub.id);
   return history.stopHub(hub.id,generation);
  },
  onStatus:()=>live.broadcast('manage_updated',{type:'manage_updated'}),
  onFatal:()=>{
   if(collectionFatal)return;
   collectionFatal=true;
   fatalPending=true;
   process.exitCode=1;
   logger.error('Observation persistence failed; collection stopped; inspect disk/database');
   void collection.stop();
   void history.stop();
   if(closeApp)void closeApp().catch(()=>{process.exitCode=1;});
  },
 });
 const stopCollection=()=>{
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(resolve,5000);timer.unref?.();});
  return Promise.race([collection.stop(),timeout]).finally(()=>clearTimeout(timer));
 };
 // History callbacks may already have accepted a complete response for the
 // SQLite writer.  Abort network work, then await the scheduler barrier before
 // closing the database so an accepted save is never cut off by shutdown.
 const stopHistory=()=>history.stop();
 const hubRows=listHubRecords(db);
 try {
  // Contract IDs are current calculation settings and must refer to a real
  // non-archived SQLite Hub.  Historical snapshots are separate data.
 validateContracts(config.contracts, hubRows.filter(h=>h.status!=='archived').map(h=>h.id));
  transaction(db,()=>recordContractSnapshots(db, config.contracts));
 } catch (error) {
  await stopCollection();
  await stopHistory();
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
 const updateManager=new UpdateManager(config,live,updateManagerOptions);
 updateManager.start();
 const management=createManagementHandler({
  config,auth,db,live,exclusive,getCollectionStatuses,onHubCommitted,onReconnect:reconnectHub,
  onHistoryRequest:id=>history.request(id,'manual'),updateManager,
 });
 const assets=new Map(['/','/index.html','/app.js','/usage-history.mjs','/update-restart.mjs','/styles.css'].map(route=>{
  const file=route==='/'?'index.html':route.slice(1);
  return [route,{bytes:fs.readFileSync(new URL(`../public/${file}`,import.meta.url)),type:file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'}];
 }));
 let closing=false;
 const handler=async(request,response)=>{
  for(const [name,value] of Object.entries(commonHeaders))response.setHeader(name,value);
  try{
   if(closing){json(response,{error:'shutting_down'},503);return;}
   if(!allowedRequest(request,config)){json(response,{error:'origin_rejected'},403);return;}
   const url=new URL(request.url,config.publicOrigin);
   if(url.pathname==='/api/health'&&request.method==='GET'){json(response,{ok:true,service:'token-monitor-analytics',version:'0.3.0',storage:'sqlite',demo:config.demo,release});return;}
   if(url.pathname==='/api/manage/hubs'||url.pathname.startsWith('/api/manage/hubs/')){
    await management.handleManage(request,response,url);return;
   }
   if(url.pathname==='/api/manage/update'||url.pathname.startsWith('/api/manage/update/')){await management.handleManage(request,response,url);return;}
   // Unknown API paths are absent from the public surface regardless of the
   // request method. Keeping this generic also prevents removed transport
   // endpoints from reaching the method gate below.
   if(url.pathname.startsWith('/api/')&&!knownApiPaths.has(url.pathname)){json(response,{error:'not_found'},404);return;}
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
    const contractsHistory=await exclusive(()=>publicContractHistory(db,config.contracts));
    json(response,{...state,serverTime:new Date().toISOString(),demo:config.demo,release,configuredHubs:currentHubs,contracts:config.contracts,contractHistory:contractsHistory,timeZone:config.timeZone,storage:'sqlite',runtime:'native-node',management:{enabled:Boolean(config.management?.enabled)}});return;
   }
   if(url.pathname==='/api/usage-history/hubs'){
    const hubs=await exclusive(()=>listHubRecords(db,{includeArchived:true}).map(hub=>({
     id:hub.id,label:hub.label,status:hub.status,version:hub.version,
     devices:listUsageHistorySources(db,hub.id),fetch:historyFetchStatus(db,hub.id),
    })));
    json(response,{hubs});return;
   }
   if(url.pathname==='/api/usage-history/sources'){
    const hubId=url.searchParams.get('hubId');
    if(!isSafeId(hubId)){json(response,{error:'invalid_hub_id'},400);return;}
    const hub=getHubRecord(db,hubId);
    if(!hub){json(response,{error:'unknown_hub'},404);return;}
    json(response,{hubId,devices:await exclusive(()=>listUsageHistorySources(db,hubId)),fetch:await exclusive(()=>historyFetchStatus(db,hubId))});return;
   }
   if(url.pathname==='/api/usage-history'){
    let query;
    try{query=historyQuery(url);}catch(error){json(response,{error:error?.code??'invalid_history_query'},error?.status??400);return;}
    const hub=getHubRecord(db,query.hubId);
    if(!hub){json(response,{error:'unknown_hub'},404);return;}
    const sources=await exclusive(()=>listUsageHistorySources(db,query.hubId));
    if(!sources.some(source=>source.deviceId===query.deviceId)){json(response,{error:'unknown_device'},404);return;}
    const result=await exclusive(()=>readUsageHistory(db,query));
    // Archived rows remain readable, but no retained value from an archived
    // registration is presented as a current source.
    if(hub.status==='archived'){
     result.archived=true;
     result.rows=result.rows.map(row=>({...row,current:false}));
     if(result.source)result.source={...result.source,archived:true,current:false};
    }
    json(response,result);return;
   }
   if(url.pathname==='/api/history'){
    const id=url.searchParams.get('contract')??'';
    const known=await exclusive(()=>config.contracts.some(c=>c.id===id)||listContractSnapshots(db).some(snapshot=>snapshot.id===id));
    if(!known){json(response,{error:'unknown_contract'},404);return;}
    json(response,{rows:await exclusive(()=>contractHistory(db,id))});return;
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
 const server=http.createServer(options,handler);
 const servers=[server];
 const sockets=new Set();
 for(const server of servers){
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 }
 try{
 await exclusive(()=>prune(db,config.detailRetentionDays));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.listen.port,config.listen.host,resolve);});
  await collection.start(collectionHubs!==undefined?collectionHubs:loadCollectionHubs());
 }catch(error){await stopCollection();await stopHistory();live.close();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));db.close();throw error;}
 const maintenance=setInterval(()=>exclusive(()=>prune(db,config.detailRetentionDays)).catch(()=>logger.error('Retention maintenance failed; inspect disk/database')),maintenanceMs);
 maintenance.unref();
 logger.info(`Analytics ready at ${config.publicOrigin} (${config.demo?'DEMO':'REAL'}; SQLite; browser SSE)`);
 const app={
  server,db,live,updateManager,collection,history,
  startCollection: hubs => collection.start(hubs),
  async close(){
   if(closing)return;closing=true;clearInterval(maintenance);await stopCollection();await stopHistory();
   // Flush the final update stage before ending SSE. The state-file watcher
   // and a browser's follow-up GET can both lose the race with service stop.
   if(!updateManager.getSupportReason()){
    try{updateManager.pollJobState(true);}catch{logger.error('Update shutdown notification failed');}
   }
   live.close();updateManager.close();
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
