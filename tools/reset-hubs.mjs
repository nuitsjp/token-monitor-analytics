import fs from 'node:fs';
import path from 'node:path';

// Called only with the Collector stopped. Remove each item only after its commit ACK.
export async function drainOutbox({directory,origin,token,send=fetch}) {
 const url=new URL(origin);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Outbox drain requires a loopback Analytics origin.');
 if(!fs.existsSync(directory))return 0;
 const names=fs.readdirSync(directory).filter(n=>n.endsWith('.json')).sort();
 let count=0;
 for(let i=0;i<names.length;i+=2){
  const batch=names.slice(i,i+2);
  let events;
  try{events=batch.map(n=>JSON.parse(fs.readFileSync(path.join(directory,n),'utf8')));}catch{throw new Error('Cannot read pending outbox; no unacknowledged data was removed.');}
  let response,ack;
  try{
   response=await send(origin+'/api/ingest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,events}),signal:AbortSignal.timeout(20000)});
   ack=await response.json();
  }catch{throw new Error('Cannot drain outbox; restore Analytics availability before resetting Hubs.');}
  if(!response.ok||!ack.ok||!Array.isArray(ack.acked)||events.some(e=>!ack.acked.includes(e.eventId)))throw new Error('Analytics did not acknowledge the pending outbox; Hub reset aborted.');
  for(const n of batch){fs.unlinkSync(path.join(directory,n));count++;}
 }
 return count;
}
