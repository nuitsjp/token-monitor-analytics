import type {Env,ObjectContext,CFSocket} from './platform.js';
import {parseBatch,readLimited} from './protocol.js';
import {checkIngest,localMode,viewerExpiry} from './auth.js';
import {ingest,dashboard,history,prune} from './db.js';
import {validateContracts} from './estimate.js';
import {settings,demoContract} from './settings.js';
export const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const room=(env:Env)=>env.LIVE.get(env.LIVE.idFromName('analytics-live'));
function contracts(demo:boolean){const cs=demo?[demoContract]:settings.contracts;validateContracts(cs,settings.hubs.map(h=>h.id));return cs;}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);const demo=localMode(request,env);
  try{
   if(url.pathname==='/api/health')return json({ok:true,service:'token-monitor-analytics',schemaVersion:1});
   if(url.pathname==='/api/ingest'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(!await checkIngest(request,env))return json({error:'unauthorized'},401);
    if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'json_required'},415);
    let batch;try{batch=parseBatch(await readLimited(request),settings.hubs.map(h=>h.id));}catch{return json({error:'invalid_batch'},400);}
    return room(env).fetch(new Request('https://internal/ingest',{method:'POST',body:JSON.stringify(batch),headers:{'X-Demo':demo?'1':'0'}}));
   }
   if(url.pathname.startsWith('/api/')){
    let expiry:number;try{expiry=await viewerExpiry(request,env);}catch{return json({error:'access_required'},401);}
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    if(url.pathname==='/api/live'){
     if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'websocket_required'},426);
     if(request.headers.get('Origin')!==url.origin)return json({error:'origin_rejected'},403);
     return room(env).fetch(new Request('https://internal/connect',{headers:{Upgrade:'websocket','X-Expires':String(expiry)}}));
    }
    const cs=contracts(demo);
    if(url.pathname==='/api/state')return json({...await dashboard(env.DB,cs),serverTime:new Date().toISOString(),demo,configuredHubs:settings.hubs,contracts:cs});
    if(url.pathname==='/api/history'){
     const id=url.searchParams.get('contract')??'';if(!cs.some(c=>c.id===id))return json({error:'unknown_contract'},404);
     return json({rows:await history(env.DB,id)});
    }
    return json({error:'not_found'},404);
   }
   // Only static, nonsensitive UI shell bypasses API auth. Access protects the hostname in production.
   return env.ASSETS.fetch(request);
  }catch{
   console.error('request failed; details suppressed to avoid payload/secret leakage');
   return json({error:'internal_error'},500);
  }
 },
 async scheduled(_event:unknown,env:Env):Promise<void>{await prune(env.DB,settings.detailRetentionDays);}
};
// A short-lived coordinator + live notifier, NOT a background SSE subscriber.
// This is one DO total for Analytics, not one DO per Hub, user or browser.
export class LiveRoom {
 constructor(private ctx:ObjectContext,private env:Env){
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
 }
 async fetch(request:Request):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname==='/connect'){
   if(this.ctx.getWebSockets().length>=16)return json({error:'viewer_limit'},429);
   const expiry=Number(request.headers.get('X-Expires'));if(!Number.isFinite(expiry)||expiry<=Date.now())return json({error:'expired'},401);
   const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({expiry});pair[1].send(JSON.stringify({type:'ready'}));
   return new Response(null,{status:101,webSocket:pair[0]} as ResponseInit);
  }
  if(url.pathname==='/ingest'&&request.method==='POST'){
   const batch=parseBatch(await request.json(),settings.hubs.map(h=>h.id));const cs=contracts(request.headers.get('X-Demo')==='1');
   // All state-dependent D1 writes are serialized. No in-memory estimate state survives separately.
   return this.ctx.blockConcurrencyWhile(async()=>{
    const changed=await ingest(this.env.DB,batch,cs,settings.timeZone);
    if(changed.length)this.broadcast({type:'updated',hubIds:changed});
    return json({ok:true,acked:batch.events.map(e=>e.eventId)});
   });
  }
  return json({error:'not_found'},404);
 }
 private broadcast(message:unknown):void{
  for(const ws of this.ctx.getWebSockets()){
   const attachment=ws.deserializeAttachment() as {expiry?:number}|null;
   try{if(!attachment?.expiry||attachment.expiry<=Date.now()){ws.close(1008,'Session expired');continue;}ws.send(JSON.stringify(message));}
   catch{try{ws.close(1011,'Disconnected');}catch{}}
  }
 }
 webSocketMessage(ws:CFSocket,_message:string|ArrayBuffer):void{ws.close(1008,'Read-only channel');}
 webSocketClose(ws:CFSocket,code:number,reason:string):void{ws.close(code===1005?1000:code,reason);}
 webSocketError(ws:CFSocket):void{try{ws.close(1011,'Socket error');}catch{}}
}
