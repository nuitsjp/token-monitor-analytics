import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {drainOutbox} from '../reset-hubs.mjs';

test('reset drain retains pending items until Analytics acknowledges every event',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tma-reset-'));
 let acknowledge=false;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const batch=JSON.parse(Buffer.concat(chunks));
  assert.equal(req.headers.authorization,'Bearer test-token');
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ok:true,acked:acknowledge?batch.events.map(e=>e.eventId):[]}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(directory,`${i}.json`),JSON.stringify({eventId:`event-${i}`}));
 const args={directory,origin:`http://127.0.0.1:${server.address().port}`,token:'test-token'};
 await assert.rejects(drainOutbox(args),/acknowledge/);
 assert.equal(fs.readdirSync(directory).length,3);
 acknowledge=true;
 assert.equal(await drainOutbox(args),3);
 assert.equal(fs.readdirSync(directory).length,0);
 assert.equal(await drainOutbox(args),0);
});
