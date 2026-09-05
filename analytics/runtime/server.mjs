import http from 'node:http';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig,credentials} from './config.mjs';
import {openDatabase} from './sqlite.mjs';
import {canIngest,canView,allowedRequest} from './auth.mjs';
import {LiveFeed} from './live.mjs';
import {parseBatch} from '../src/protocol.ts';
import {ingest,dashboard,history,prune} from '../src/db.ts';

const commonHeaders={
 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
function json(response,data,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));}
async function body(request){
 const limit=270000,declared=request.headers['content-length'];
 if(declared && (!/^\d+$/.test(declared)||Number(declared)>limit))throw Object.assign(new Error('body_too_large'),{status:413});
 let total=0;const chunks=[];
 // A stalled sender must not keep a body reader alive indefinitely.
 request.setTimeout(15000,()=>request.destroy());
 for await(const chunk of request){total+=chunk.length;if(total>limit)throw Object.assign(new Error('body_too_large'),{status:413});chunks.push(chunk);}
 request.setTimeout(0);
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startServer(config,{env=process.env,logger=console,maintenanceMs=300000,heartbeatMs=25000}={}){
 const auth=credentials(config,env);
 const db=openDatabase(config.databasePath,{demo:config.demo});
 let tail=Promise.resolve();
 const exclusive=callback=>{const next=tail.then(callback);tail=next.catch(()=>{});return next;};
 const live=new LiveFeed({heartbeatMs});
 const assets=new Map(['/','/index.html','/app.js','/styles.css'].map(route=>{
  const file=route==='/'?'index.html':route.slice(1);
  return [route,{bytes:fs.readFileSync(new URL(`../public/${file}`,import.meta.url)),type:file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'}];
 }));
 let closing=false;
 const server=http.createServer({maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000,keepAliveTimeout:5000},async(request,response)=>{
  for(const [name,value] of Object.entries(commonHeaders))response.setHeader(name,value);
  try{
   if(closing){json(response,{error:'shutting_down'},503);return;}
   if(!allowedRequest(request,config)){json(response,{error:'origin_rejected'},403);return;}
   const url=new URL(request.url,config.publicOrigin);
   if(url.pathname==='/api/health'&&request.method==='GET'){json(response,{ok:true,service:'token-monitor-analytics',version:'0.3.0',storage:'sqlite',demo:config.demo});return;}
   if(url.pathname==='/api/ingest'){
    if(request.method!=='POST'){json(response,{error:'method_not_allowed'},405);return;}
    if(!canIngest(request,auth)){json(response,{error:'unauthorized'},401);return;}
    if((request.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json'){json(response,{error:'json_required'},415);return;}
    let batch;
    try{batch=parseBatch(await body(request),config.hubs.map(h=>h.id));}
    catch(error){if(!response.destroyed)json(response,{error:'invalid_batch'},error.status===413?413:400);return;}
    const changed=await exclusive(()=>db.transaction(()=>ingest(db,batch,config.contracts,config.timeZone)));
    // Notify and acknowledge only after the SQLite COMMIT succeeded.
    if(changed.length)live.updated(changed);
    json(response,{ok:true,acked:batch.events.map(e=>e.eventId)});return;
   }
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
    json(response,{...state,serverTime:new Date().toISOString(),demo:config.demo,configuredHubs:config.hubs,contracts:config.contracts,timeZone:config.timeZone,storage:'sqlite',runtime:'native-node'});return;
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
 });
 const sockets=new Set();
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 try{
  await exclusive(()=>prune(db,config.detailRetentionDays));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.listen.port,config.listen.host,resolve);});
 }catch(error){live.close();db.close();throw error;}
 const maintenance=setInterval(()=>exclusive(()=>prune(db,config.detailRetentionDays)).catch(()=>logger.error('Retention maintenance failed; inspect disk/database')),maintenanceMs);
 maintenance.unref();
 logger.info(`Analytics ready at ${config.publicOrigin} (${config.demo?'DEMO':'REAL'}; SQLite; browser SSE)`);
 return {
  server,db,live,
  async close(){
   if(closing)return;closing=true;clearInterval(maintenance);live.close();
   const force=setTimeout(()=>{for(const socket of sockets)socket.destroy();},5000);force.unref();
   await new Promise(resolve=>server.close(resolve));clearTimeout(force);
   await tail;db.close();
  }
 };
}
async function main(){
 const {values}=parseArgs({options:{config:{type:'string',default:'config.local.json'}},strict:true});
 const config=loadConfig(values.config);
 // Demo is an isolated, loopback-only dataset. Do not inherit production tokens.
 if(config.demo)process.env[config.ingestTokenEnv]='demo-ingest-token-not-for-production';
 const app=await startServer(config);
 let stopping=false;
 for(const name of ['SIGINT','SIGTERM'])process.on(name,async()=>{
  if(stopping)return;stopping=true;
  try{await app.close();process.exitCode=0;}catch{process.exitCode=1;}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(error=>{console.error(`Analytics startup failed: ${error.message}`);process.exitCode=1;});
}
