// TEST HARNESS ONLY. Does not emulate Cloudflare metering, hibernation or WebSockets.
// Run after: cd analytics && npm run build:test
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import worker,{LiveRoom} from '../analytics/.test-build/index.js';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=process.env.TMA_TEST_DB??':memory:';const db=new DatabaseSync(file);
const schema=fs.readFileSync(path.join(root,'analytics/migrations/0001_initial.sql'),'utf8').replaceAll('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ');db.exec(schema);
const wrap=(text,args=[])=>({bind(...a){return wrap(text,a)},async all(){return {results:db.prepare(text).all(...args),success:true,meta:{}}},async first(){return db.prepare(text).get(...args)??null},async run(){const x=db.prepare(text).run(...args);return {success:true,results:[],meta:{changes:Number(x.changes)}}}});
const DB={prepare:wrap,async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
globalThis.WebSocketRequestResponsePair=class{};
let serial=Promise.resolve();const ctx={setWebSocketAutoResponse(){},getWebSockets(){return []},blockConcurrencyWhile(f){const next=serial.then(f);serial=next.catch(()=>{});return next}};
const env={DB,AUTH_MODE:'local',INGEST_TOKEN:'demo-ingest-token-not-for-production',ASSETS:{async fetch(request){const pathname=new URL(request.url).pathname;const allowed=new Set(['/','/index.html','/app.js','/styles.css']);if(!allowed.has(pathname))return new Response('not found',{status:404});const name=pathname==='/'?'index.html':pathname.slice(1);return new Response(fs.readFileSync(path.join(root,'analytics/public',name)),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8'}})}}};
const room=new LiveRoom(ctx,env);env.LIVE={idFromName:x=>x,get:()=>({fetch:r=>room.fetch(r)})};
const server=http.createServer(async(req,res)=>{try{if(req.url==='/api/live'){res.writeHead(426);res.end('WebSocket runtime not emulated');return;}const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const r=new Request(`http://127.0.0.1:8787${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});const out=await worker.fetch(r,env);res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));}catch(e){console.error(e);res.writeHead(500);res.end('test harness failure')}});
server.listen(8787,'127.0.0.1',()=>console.log('TEST harness ready: http://127.0.0.1:8787 (no real WebSocket/DO runtime)'));
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>server.close(()=>{db.close();process.exit(0)}));
