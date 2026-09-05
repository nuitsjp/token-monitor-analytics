import test from 'node:test';import assert from 'node:assert/strict';
import {checkIngest,localMode,verifyJWT} from '../.test-build/auth.js';
import worker,{LiveRoom} from '../.test-build/index.js';
import {database,observation} from './adapter.mjs';
test('local mode does not bypass deployed hosts',()=>{assert.equal(localMode(new Request('https://example.com'),{AUTH_MODE:'local'}),false);assert.equal(localMode(new Request('http://127.0.0.1:8787'),{AUTH_MODE:'local'}),true)});
test('ingest secret, missing config, wrong token',async()=>{const r=new Request('https://test',{headers:{authorization:'Bearer abcdefghijklmnop'}});assert.equal(await checkIngest(r,{INGEST_TOKEN:'abcdefghijklmnop'}),true);assert.equal(await checkIngest(r,{INGEST_TOKEN:'abcdefghijklmnopq'}),false);assert.equal(await checkIngest(r,{}),false)});
test('Access RS256 signature, issuer, audience and expiration',async()=>{
 const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pub={...await crypto.subtle.exportKey('jwk',kp.publicKey),kid:'test-key',use:'sig',alg:'RS256'};
 const fetcher=async()=>Response.json({keys:[pub]});const now=Date.now(),domain='tma-test.cloudflareaccess.com';
 const sign=async(claims,header={alg:'RS256',kid:'test-key'})=>{const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const text=`${b(header)}.${b(claims)}`;const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,new TextEncoder().encode(text));return `${text}.${Buffer.from(sig).toString('base64url')}`};
 const claims={iss:`https://${domain}`,aud:['aud'],exp:Math.floor(now/1000)+600};
 const t=await sign(claims);assert.ok(await verifyJWT(t,domain,'aud',fetcher,now)>now);
 await assert.rejects(verifyJWT(t,domain,'wrong',fetcher,now));await assert.rejects(verifyJWT(await sign({...claims,exp:0}),domain,'aud',fetcher,now));await assert.rejects(verifyJWT(await sign({...claims,iss:'https://evil'}),domain,'aud',fetcher,now));await assert.rejects(verifyJWT(await sign(claims,{alg:'none',kid:'test-key'}),domain,'aud',fetcher,now));
 const parts=t.split('.');parts[1]=Buffer.from(JSON.stringify({...claims,sub:'tampered'})).toString('base64url');await assert.rejects(verifyJWT(parts.join('.'),domain,'aud',fetcher,now));
});
test('API rejects anonymous read and unknown ingest token',async()=>{const env={AUTH_MODE:'access',ASSETS:{fetch:()=>new Response('shell')}};assert.equal((await worker.fetch(new Request('https://test/api/state'),env)).status,401);assert.equal((await worker.fetch(new Request('https://test/api/ingest',{method:'POST'}),env)).status,401)});
test('live endpoint rejects cross-origin browser',async()=>{const env={AUTH_MODE:'local'};const r=await worker.fetch(new Request('http://127.0.0.1/api/live',{headers:{Upgrade:'websocket',Origin:'https://evil'}}),env);assert.equal(r.status,403)});
test('Worker -> LiveRoom -> SQLite -> ack -> dashboard',async()=>{
 globalThis.WebSocketRequestResponsePair=class{};const db=database();let lockCalls=0;
 const ctx={setWebSocketAutoResponse(){},getWebSockets(){return []},async blockConcurrencyWhile(f){lockCalls++;return f()}};
 const env={DB:db,AUTH_MODE:'local',INGEST_TOKEN:'demo-ingest-token-not-for-production'};const room=new LiveRoom(ctx,env);env.LIVE={idFromName:x=>x,get:()=>({fetch:r=>room.fetch(r)})};
 const o=observation();o.stats.devices[0].deviceId='demo-pc';o.stats.limits.providers[0].accountKey='demo-account';
 const r=await worker.fetch(new Request('http://127.0.0.1/api/ingest',{method:'POST',headers:{authorization:`Bearer ${env.INGEST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,events:[o]})}),env);
 assert.equal(r.status,200);assert.deepEqual((await r.json()).acked,[o.eventId]);assert.equal(lockCalls,1);
 const state=await worker.fetch(new Request('http://127.0.0.1/api/state'),env);assert.equal((await state.json()).hubs.length,1);db.sql.close();
});

test('live notifier emits only after storage and rejects expired recipients',async()=>{
 globalThis.WebSocketRequestResponsePair=class{};const db=database(),messages=[],closed=[];
 const valid={deserializeAttachment:()=>({expiry:Date.now()+60000}),send:m=>messages.push(JSON.parse(m)),close:c=>closed.push(c)};
 const expired={deserializeAttachment:()=>({expiry:1}),send:()=>assert.fail('expired recipient got data'),close:c=>closed.push(c)};
 const room=new LiveRoom({setWebSocketAutoResponse(){},getWebSockets(){return [valid,expired]},blockConcurrencyWhile:f=>f()},{DB:db});
 const r=await room.fetch(new Request('https://internal/ingest',{method:'POST',body:JSON.stringify({schemaVersion:1,events:[observation()]})}));
 assert.equal(r.status,200);assert.equal(db.sql.prepare('SELECT count(*) n FROM observations').get().n,1);assert.equal(messages[0].type,'updated');assert.deepEqual(closed,[1008]);db.sql.close();
});
