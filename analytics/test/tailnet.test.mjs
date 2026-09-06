import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {Readable} from 'node:stream';
import {startServer} from '../runtime/server.mjs';
import {loadConfig,isTailnetIPv4,validateTailnetBinding} from '../runtime/config.mjs';
import {observation} from './adapter.mjs';
const env={TMA_INGEST_TOKEN:'test-ingest-token-12345678901234567890',TMA_VIEWER_USER:'viewer',TMA_VIEWER_PASSWORD:'test-independent-password-123456789'};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tma-tailnet-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const raw=JSON.parse(fs.readFileSync(new URL('../configs/demo.json',import.meta.url),'utf8'));
 Object.assign(raw,{demo:false,databasePath:path.join(dir,'real.db'),publicOrigin:'http://host.example.ts.net:8788',listen:{host:'127.0.0.1',port:8788},tailnetViewer:{host:'100.69.11.74',port:8788},viewerAuth:{mode:'basic',userEnv:'TMA_VIEWER_USER',passwordEnv:'TMA_VIEWER_PASSWORD'}});
 const file=path.join(dir,'config.json');const write=()=>fs.writeFileSync(file,JSON.stringify(raw));write();return {raw,file,write};
}
test('tailnet mode requires a named tailnet, explicit CGN address and Basic auth',t=>{
 const f=fixture(t);assert.ok(loadConfig(f.file).tailnetViewer);
 for(const ip of ['0.0.0.0','192.168.1.2','127.0.0.1','100.128.0.1']){f.raw.tailnetViewer.host=ip;f.write();assert.throws(()=>loadConfig(f.file));}
 f.raw.tailnetViewer.host='100.69.11.74';f.raw.demo=true;f.write();assert.throws(()=>loadConfig(f.file));
 f.raw.demo=false;f.raw.viewerAuth.mode='loopback';f.write();assert.throws(()=>loadConfig(f.file));
});
test('runtime checks that viewer IP belongs to a Tailscale interface',()=>{
 const c={tailnetViewer:{host:'100.69.11.74'}};
 assert.throws(()=>validateTailnetBinding(c,{eth0:[{address:'100.69.11.74'}]}));
 assert.doesNotThrow(()=>validateTailnetBinding(c,{tailscale0:[{address:'100.69.11.74'}]}));
});
const address=Object.entries(os.networkInterfaces()).filter(([name])=>/^tailscale/i.test(name)).flatMap(([,a])=>a??[]).find(a=>isTailnetIPv4(a.address))?.address;
test('two actual listeners share SQLite and SSE; tailnet ingest is always blocked',{skip:address?false:'Requires an assigned Tailscale interface',timeout:15000},async t=>{
 const f=fixture(t);f.raw.tailnetViewer.host=address;
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 f.raw.listen.port=port;f.raw.tailnetViewer.port=port;f.raw.publicOrigin=`http://host.example.ts.net:${port}`;f.write();
 const app=await startServer(loadConfig(f.file),{env,heartbeatMs:50,logger:{info(){},error(){}}});
 const ctrl=new AbortController();t.after(async()=>{ctrl.abort();await app.close();});
 const basic='Basic '+Buffer.from('viewer:'+env.TMA_VIEWER_PASSWORD).toString('base64');
 const host=`host.example.ts.net:${port}`,url=`http://${address}:${port}`;
 const send=(route,options={})=>new Promise((resolve,reject)=>{
  const request=http.request(url+route,{...options,headers:{Host:host,...options.headers}},response=>resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers:response.headers})));
  request.on('error',reject);request.end();
 });
 for(const headers of [{},{Authorization:'Bearer '+env.TMA_INGEST_TOKEN},{Authorization:basic,'X-Forwarded-For':'127.0.0.1'}])assert.equal((await send('/api/ingest',{method:'POST',headers})).status,404);
 assert.equal((await send('/api/state')).status,401);
 const stream=await send('/api/live',{headers:{Authorization:basic},signal:ctrl.signal});assert.equal(stream.status,200);const reader=stream.body.getReader();
 let frames='';while(!frames.includes('event: ready'))frames+=new TextDecoder().decode((await reader.read()).value);
 const post=await fetch(`http://127.0.0.1:${port}/api/ingest`,{method:'POST',headers:{Authorization:'Bearer '+env.TMA_INGEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,events:[observation(0,10),observation(1,20)]})});
 assert.equal(post.status,200);await post.arrayBuffer();
 while(!frames.includes('event: updated'))frames+=new TextDecoder().decode((await reader.read()).value);
 assert.equal(app.db.sql.prepare('SELECT count(*) n FROM observations').get().n,2);
 assert.equal((await send('/api/state',{headers:{Authorization:basic}})).status,200);ctrl.abort();
});
